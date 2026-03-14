/********************************************************************************
 * MD2Renderer.js
 * 
 * A renderer for MD2 models (Quake, Doom, etc.) built in HTML5 and WebGL,
 * with support for animations and textures.
 * 
 * Currently only supports providing a single skin texture per model,
 * but does extract and store all skin names from the MD2 file.
 * 
 * @author Matthew Lynch
 * @license 
 * Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)	
 *******************************************************************************/

// WEBGL SHADERS ///////////////////////////////////////////////////////

const MD2_VERT_SRC = `
attribute vec3 aPos0;
attribute vec3 aPos1;
attribute vec2 aTexCoord;

uniform float uLerp;
uniform mat4  uMVP;

varying vec2 vTexCoord;

void main()
{
    vec3 pos = mix(aPos0, aPos1, uLerp); // interpolate between current and next keyframe positions
    gl_Position = uMVP * vec4(pos, 1.0);
    vTexCoord   = aTexCoord;
}
`;

const MD2_FRAG_SRC = `
precision mediump float;

uniform sampler2D uSkin;
uniform int       uHasSkin;

varying vec2 vTexCoord;

void main()
{
    if(uHasSkin == 1)
    {
        gl_FragColor = texture2D(uSkin, vTexCoord);
    }
    else
    {
        gl_FragColor = vec4(0.7, 0.7, 0.7, 1.0);
    }
}
`;

// HTML5 RENDERER //////////////////////////////////////////////////////

class MD2Renderer
{
    constructor(canvas)
    {
        this.canvas = canvas;
        const gl = canvas.getContext("webgl");

        if(!gl) { throw new Error("WebGL not supported"); }

        this.gl = gl;

        this.program     = this.buildProgram(gl, MD2_VERT_SRC, MD2_FRAG_SRC);
        this.locs        = this.getLocations(gl, this.program);
        this.texCoordBuf = null;
        this.frameBufs   = []; // one position (vertex) buffer per frame
        this.texture     = null;
        this.hasSkin     = false;
        this.vertCount   = 0;

        // animation state
        this.animations    = [];
        this.animIndex     = 0;
        this.frameRelative = 0; // index within current animation
        this.lerpFactor    = 0;
        this.msPerFrame    = 1000 / 10;
        this.playing       = true;

        // rotation state
        this.azimuth   = 0;
        this.elevation = -0.3;

        // camera distance (updated when model loads)
        this.camDist = 100;

        // render state
        this.lastTime    = null;
        this.rafId       = null;
        this.modelLoaded = false;

        // resize handler
        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(canvas);
        this.onResize();

        // mouse handler
        this.drag = null;
        this.bindMouse();
    }

    // LOAD MODEL / TEXTURE ///////////////////////////////////////////////

    loadModel(modelData)
    {
        // modelData from MD2Loader.parse()

        const gl = this.gl;
        this.freeModelBuffers();

        const { triangles, texCoords, frames, header, animations } = modelData;
        const numTri = header.numTriangles;

        this.vertCount = numTri * 3;

        // MD2 stores the position (vertices) and texture coordinates (UVs) of triangles as indices that point to shared arrays,
        // which saves space by enabling positions and texcoords to be reused across multiple triangles.
        
        // WebGL doesn't support indexed attributes for vertices, so we have to "unweld" the model into flat attribute buffers,
        // ensuring each triangle has 3 independent vertices, each with its own copy of corresponding position and texcoord data.

        // triangle array layout: [vi0, vi1, vi2, ti0, ti1, ti2] (indices of vertices and texcoords)

        // texture coordinates buffer
        // identical across all frames
        const tcData = new Float32Array(numTri * 3 * 2);

        for(let t = 0; t < numTri; t++)
        {
            for(let c = 0; c < 3; c++)
            {
                // texcoord index for this corner
                const ti = triangles[t * 6 + 3 + c];

                tcData[(t * 3 + c) * 2]     = texCoords[ti * 2];
                tcData[(t * 3 + c) * 2 + 1] = texCoords[ti * 2 + 1];
            }
        }

        this.texCoordBuf = this.makeBuffer(gl, tcData);

        // position (vertex) buffers
        // one per frame (positions differ each frame, topology does not)
        this.frameBufs = frames.map(frame => 
        {   
            const posData = new Float32Array(numTri * 3 * 3);
            
            for(let t = 0; t < numTri; t++)
            {
                for(let c = 0; c < 3; c++)
                {
                    // vertex index for this corner
                    const vi = triangles[t * 6 + c];

                    posData[(t * 3 + c) * 3]     = frame.positions[vi * 3];
                    posData[(t * 3 + c) * 3 + 1] = frame.positions[vi * 3 + 1];
                    posData[(t * 3 + c) * 3 + 2] = frame.positions[vi * 3 + 2];
                }
            }

            return this.makeBuffer(gl, posData);
        });

        // update camera distance to ensure model fits in view
        // based on size of the bounding sphere of first frame
        this.camDist = this.estimateCamDist(frames);

        // prepare animations
        this.animations    = animations;
        this.animIndex     = 0;
        this.frameRelative = 0;
        this.lerpFactor    = 0;
        this.modelLoaded   = true;
    }

    loadSkinTexture(image)
    {
        const gl = this.gl;

        // clean up old texture if it exists
        if(this.texture) { gl.deleteTexture(this.texture); }

        const tex = gl.createTexture();

        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        this.texture = tex;
        this.hasSkin = true;
    }

    // ANIMATION & ROTATION ///////////////////////////////////////////////

    get currentAnimIndex() { return this.animIndex; }

    get frameInfo()
    {
        if(!this.animations.length) { return { frame: 0, totalFrames: 0 }; }

        const anim = this.animations[this.animIndex];
        const total = anim.end - anim.start + 1;

        return { frame: this.frameRelative + 1, totalFrames: total };
    }

    play() { this.playing = true; }
    
    pause() { this.playing = false; }

    setAnimation(name)
    {
        const idx = this.animations.findIndex(a => a.name === name);

        // abort if animation doesn't exist
        if(idx === -1) { return; }

        this.animIndex     = idx;
        this.frameRelative = 0;
        this.lerpFactor    = 0;
    }

    setSpeed(fps)
    {
        this.msPerFrame = 1000 / Math.max(1, fps);
    }

    setRotation(azimuth, elevation)
    {
        this.azimuth   = azimuth; // in radians
        this.elevation = elevation; // in radians
    }

    update(deltaMs)
    {
        if(!this.animations.length) { return; }

        // lerpFactor tracks sub-frame progress: 0 = start of current frame, 1 = start of next.

        // when lerpFactor >= 1 we advance to the next frame and carry over the remainder
        // so the animation speed stays consistent even across frame boundaries.

        this.lerpFactor += deltaMs / this.msPerFrame;

        if(this.lerpFactor >= 1)
        {
            const anim  = this.animations[this.animIndex];
            const total = anim.end - anim.start + 1;

            this.lerpFactor -= 1;
            this.frameRelative = (this.frameRelative + 1) % total;
        }
    }

    currentFrameIndex()
    {
        if(!this.animations.length) { return 0; }

        return this.animations[this.animIndex].start + this.frameRelative;
    }

    nextFrameIndex()
    {
        if(!this.animations.length) { return 0; }

        const anim  = this.animations[this.animIndex];
        const total = anim.end - anim.start + 1;
        const rel   = (this.frameRelative + 1) % total;

        return anim.start + rel;
    }

    // RENDERING  /////////////////////////////////////////////////////////

    startRenderLoop()
    {
        const loop = (ts) =>
        {
            this.rafId = requestAnimationFrame(loop);

            if(this.lastTime === null) { this.lastTime = ts; }

            // clamp delta so a long loss of focus doesn't cause issues
            // e.g. someone switches to another tab for a while
            const delta = Math.min(ts - this.lastTime, 100);
            this.lastTime = ts;
            
            if(this.modelLoaded)
            {
                if(this.playing) { this.update(delta); }

                this.render();
            }
            else
            {
                this.renderEmpty();
            }
        };

        this.rafId = requestAnimationFrame(loop);
    }

    render()
    {
        const gl = this.gl;
        
        const w = this.canvas.width;
        const h = this.canvas.height;

        // clear canvas and reset WebGL state
        gl.viewport(0, 0, w, h);
        gl.clearColor(0.15, 0.15, 0.18, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);
        gl.frontFace(gl.CW); // MD2 triangles are constructed clockwise when viewed from outside

        // attach the shader
        gl.useProgram(this.program);

        // compute the model-view-projection matrix
        // we want a simple orbit camera that can rotate around the model
        const proj = Mat4.perspective(Math.PI / 4, w / h, 0.1, 10000);
        const eye  = [0, 0, this.camDist];
        const view = Mat4.lookAt(eye, [0, 0, 0], [0, 1, 0]);
        const rotY = Mat4.rotateY(this.azimuth);
        const rotX = Mat4.rotateX(this.elevation);
        const mvp  = Mat4.multiply(proj, Mat4.multiply(view, Mat4.multiply(rotY, rotX)));

        // set the shader uniforms
        gl.uniformMatrix4fv(this.locs.uMVP, false, mvp);
        gl.uniform1f(this.locs.uLerp, this.lerpFactor);
        gl.uniform1i(this.locs.uHasSkin, this.hasSkin ? 1 : 0);

        // bind texture
        if(this.hasSkin && this.texture)
        {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.uniform1i(this.locs.uSkin, 0);
        }

        // bind current frame positions (aPos0)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.frameBufs[this.currentFrameIndex()]);
        gl.enableVertexAttribArray(this.locs.aPos0);
        gl.vertexAttribPointer(this.locs.aPos0, 3, gl.FLOAT, false, 0, 0);

        // bind next frame positions (aPos1)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.frameBufs[this.nextFrameIndex()]);
        gl.enableVertexAttribArray(this.locs.aPos1);
        gl.vertexAttribPointer(this.locs.aPos1, 3, gl.FLOAT, false, 0, 0);

        // bind texture coordinates
        gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuf);
        gl.enableVertexAttribArray(this.locs.aTexCoord);
        gl.vertexAttribPointer(this.locs.aTexCoord, 2, gl.FLOAT, false, 0, 0);

        // draw the triangles
        gl.drawArrays(gl.TRIANGLES, 0, this.vertCount);
    }

    renderEmpty()
    {
        const gl = this.gl;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0.15, 0.15, 0.18, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    destroy()
    {
        // stop render loop
        if(this.rafId) { cancelAnimationFrame(this.rafId); }

        // destroy WebGL resources
        this.freeModelBuffers();
        
        if(this.texture) { this.gl.deleteTexture(this.texture); }
        if(this.program) { this.gl.deleteProgram(this.program); }

        // disconnect resize handler
        this.resizeObserver.disconnect();
    }

    // WEBGL HELPERS ///////////////////////////////////////////////////////

    compileShader(gl, type, src)
    {
        const shader = gl.createShader(type);

        gl.shaderSource(shader, src);
        gl.compileShader(shader);

        if(!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        {
            throw new Error(`error compiling shader: ${gl.getShaderInfoLog(shader)}`);
        }
        
        return shader;
    }

    buildProgram(gl, vertSrc, fragSrc)
    {
        const vert = this.compileShader(gl, gl.VERTEX_SHADER, vertSrc);
        const frag = this.compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
        const prog = gl.createProgram();

        gl.attachShader(prog, vert);
        gl.attachShader(prog, frag);
        gl.linkProgram(prog);

        if(!gl.getProgramParameter(prog, gl.LINK_STATUS))
        {
            throw new Error(`error linking shader: ${gl.getProgramInfoLog(prog)}`);
        }

        // clean up shaders (no longer needed once linked into a program)
        gl.deleteShader(vert);
        gl.deleteShader(frag);

        return prog;
    }

    getLocations(gl, prog)
    {
        return {
            aPos0:     gl.getAttribLocation(prog,  "aPos0"),
            aPos1:     gl.getAttribLocation(prog,  "aPos1"),
            aTexCoord: gl.getAttribLocation(prog,  "aTexCoord"),
            uLerp:     gl.getUniformLocation(prog, "uLerp"),
            uMVP:      gl.getUniformLocation(prog, "uMVP"),
            uSkin:     gl.getUniformLocation(prog, "uSkin"),
            uHasSkin:  gl.getUniformLocation(prog, "uHasSkin"),
        };
    }

    makeBuffer(gl, data)
    {
        const buff = gl.createBuffer();

        gl.bindBuffer(gl.ARRAY_BUFFER, buff);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

        return buff;
    }

    freeModelBuffers()
    {
        const gl = this.gl;

        if(this.texCoordBuf)
        { 
            gl.deleteBuffer(this.texCoordBuf); 
            this.texCoordBuf = null;
        }

        for(const buff of this.frameBufs)
        {
            gl.deleteBuffer(buff);
        } 
        
        this.frameBufs = [];
        this.modelLoaded = false;
    }

    // CAMERA / VIEW ///////////////////////////////////////////////////////

    estimateCamDist(frames)
    {
        // sample first frame to get rough size of model
        // from the radius of the of bounding sphere

        const pos = frames[0].positions;
        let maxR = 0;
        
        for(let i = 0; i < pos.length; i += 3)
        {
            const r = Math.hypot(pos[i], pos[i + 1], pos[i + 2]);    
            if(r > maxR) { maxR = r; }
        }

        return maxR * 3;
    }

    onResize()
    {
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width  = rect.width  || 800;
        this.canvas.height = rect.height || 600;
    }

    // INPUT / MOUSE //////////////////////////////////////////////////////

    bindMouse()
    {
        const canvas = this.canvas;

        const onDown = (e) =>
        {
            this.drag = { x: e.clientX, y: e.clientY };
        };

        const onMove = (e) =>
        {
            if(!this.drag) { return; }

            const dx = e.clientX - this.drag.x;
            const dy = e.clientY - this.drag.y;

            this.azimuth   += dx * 0.01;
            this.elevation += dy * 0.01;
            this.elevation  = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.elevation));
            this.drag = { x: e.clientX, y: e.clientY };
        };

        const onUp = () => { this.drag = null; };

        canvas.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup',   onUp);

        // touch support for mobile devices
        canvas.addEventListener('touchstart', (e) => 
        {
            e.preventDefault();
            onDown(e.touches[0]);
        }, { passive: false });

        window.addEventListener('touchmove', (e) =>
        {
            if(this.drag) { e.preventDefault(); }
            onMove(e.touches[0]);
        }, { passive: false });

        window.addEventListener('touchend', onUp);
    }
}
