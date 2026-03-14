/********************************************************************************
 * MD2Loader.js
 * 
 * A simple loader for MD2 models that prepares the models for use with WebGL.
 * 
 * MD2 is a legacy model and keyframe animation format used in classic games like Quake 2 and Doom.
 * A simple format that stores a list of vertex positions for each frame of animation, with no bones, 
 * skinning weights, or other modern complexities. Great for learning the basics of 3D rendering and animation.
 * 
 * @author Matthew Lynch
 * @license 
 * Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)	
 *******************************************************************************/

class MD2Loader
{
    parse(buffer)
    {
        // MD2 files are laid out as a 68-byte header followed by five data sections
        // whose offsets are stored in the header:
        //
        // skins     - 64 char file paths to skin (texture) images (currently ignored)
        // texCoords - per-vertex UV coordinates, stored as int16 pixel values
        // triangles - triangle list with 3 vertex indices + 3 texcoord indices per triangle
        // frames    - per-frame vertex positions, compressed to one byte per axis
        // glCmds    - legacy Gl commands (ignored here)
        
        // all values are little-endian.

        const view   = new DataView(buffer);
        const header = this.parseHeader(view);

        if(header.magic !== 0x32504449)
        {
            // a "magic" number included to verify that the file is actually an MD2 model
            // the number should equal "IDP2" in ASCII (little-endian byte order)

            throw new Error("not a valid MD2 file (bad magic number)");
        }

        if(header.version !== 8)
        {
            // only support version 8, which was the stable/release version used in Quake 2
            // and is the most widely supported version in custom modeling tools

            throw new Error(`unsupported MD2 version: ${header.version}`);
        }

        const skins      = this.parseSkins(view, header);
        const texCoords  = this.parseTexCoords(view, header);
        const triangles  = this.parseTriangles(view, header);
        const frames     = this.parseFrames(view, header);
        const animations = this.parseAnimations(frames);

        return { header, skins, texCoords, triangles, frames, animations };
    }

    parseHeader(view)
    {
        // 17 × int32 (68 bytes)
        return {
            magic:           view.getUint32(0,  true),
            version:         view.getInt32(4,   true),
            skinWidth:       view.getInt32(8,   true), 
            skinHeight:      view.getInt32(12,  true),
            frameSize:       view.getInt32(16,  true), // byte size of one frame (varies with vertex count)
            numSkins:        view.getInt32(20,  true),
            numVertices:     view.getInt32(24,  true), // vertices per frame
            numTexCoords:    view.getInt32(28,  true),
            numTriangles:    view.getInt32(32,  true),
            numGlCmds:       view.getInt32(36,  true), // legacy GL support (ignored)
            numFrames:       view.getInt32(40,  true),
            offsetSkins:     view.getInt32(44,  true), // byte offsets to each section
            offsetTexCoords: view.getInt32(48,  true),
            offsetTriangles: view.getInt32(52,  true),
            offsetFrames:    view.getInt32(56,  true),
            offsetGlCmds:    view.getInt32(60,  true),
            offsetEnd:       view.getInt32(64,  true), // should equal file size
        };
    }

    parseSkins(view, header)
    {
        // skin paths are loaded here, but the MD2Renderer currently ignores them
        
        // each skin entry is a null-terminated file path
        // all paths are padded to 64 characters

        const skins = [];
        const bytes = new Uint8Array(view.buffer);

        for(let i = 0; i < header.numSkins; i++)
        {
            const base = header.offsetSkins + i * 64;

            let name = "";
            for(let c = 0; c < 64; c++)
            {
                const ch = bytes[base + c];

                if(ch === 0) { break; } // null terminator

                name += String.fromCharCode(ch);
            }

            skins.push(name);
        }

        return skins;
    }

    parseTexCoords(view, header)
    {
        // texture coordinates (UVs) are stored as int16 pixel values
        // divide by the skin dimensions to get normalised 0 to 1 values for the GPU

        const count      = header.numTexCoords;
        const skinWidth  = header.skinWidth;
        const skinHeight = header.skinHeight;
        const out        = new Float32Array(count * 2); // interleaved [u, v, u, v, ...]
        
        let base = header.offsetTexCoords;
        for(let i = 0; i < count; i++)
        {
            out[i * 2]     = view.getInt16(base,     true) / skinWidth;
            out[i * 2 + 1] = view.getInt16(base + 2, true) / skinHeight;
            base += 4; // 2 × int16
        }

        return out;
    }

    parseTriangles(view, header)
    {
        // each triangle stores 3 vertex indices followed by 3 texcoord indices
        // [vi0, vi1, vi2, ti0, ti1, ti2] (6 × uint16 = 12 bytes).
         
        // vertex (position) and texcoord are stored as indices into lookup tables
        // because one vertex position can map to different UVs on different triangles

        const count = header.numTriangles;
        const out   = new Uint16Array(count * 6);
        
        let base = header.offsetTriangles;
        for(let i = 0; i < count; i++)
        {
            out[i * 6]     = view.getUint16(base,      true); // vertex index 0
            out[i * 6 + 1] = view.getUint16(base + 2,  true); // vertex index 1
            out[i * 6 + 2] = view.getUint16(base + 4,  true); // vertex index 2
            out[i * 6 + 3] = view.getUint16(base + 6,  true); // texcoord index 0
            out[i * 6 + 4] = view.getUint16(base + 8,  true); // texcoord index 1
            out[i * 6 + 5] = view.getUint16(base + 10, true); // texcoord index 2
            
            base += 12; // 6 × uint16
        }

        return out;
    }

    parseFrames(view, header)
    {
        // each frame begins with a 40-byte header:
        // scale[3]     - 3 × float32 (12 bytes)
        // translate[3] - 3 × float32 (12 bytes)
        // name         - char[16]    (16 bytes)

        // the header is followed by numVertices × 4 bytes of compressed vertex data.

        const frames = [];
        const bytes  = new Uint8Array(view.buffer);
        const { numFrames, numVertices, offsetFrames, frameSize } = header;

        for(let f = 0; f < numFrames; f++)
        {
            const frameBase = offsetFrames + f * frameSize;

            const scaleX = view.getFloat32(frameBase,      true);
            const scaleY = view.getFloat32(frameBase + 4,  true);
            const scaleZ = view.getFloat32(frameBase + 8,  true);
            const transX = view.getFloat32(frameBase + 12, true);
            const transY = view.getFloat32(frameBase + 16, true);
            const transZ = view.getFloat32(frameBase + 20, true);

            // frame names are null-terminated strings padded to 16 characters
            let name = "";
            for(let c = 0; c < 16; c++)
            {
                const ch = bytes[frameBase + 24 + c];
                
                if(ch === 0) { break; }
                
                name += String.fromCharCode(ch);
            }

            // vertex data begins at byte 40 of the frame
            // each vertex is 4 bytes: compX, compY, compZ, and normalIndex

            // normalIndex was used to squeeze extra performance out of older computers using precomputed normals and lookup tables, 
            // but is not needed here since we can now calculate smooth normals on the GPU via WebGL shaders.
            
            // vertex data is compressed with the real position calculated as:
            // compressed × scale + translate (per axis)

            const vertBase = frameBase + 40;
            const positions = new Float32Array(numVertices * 3);

            for (let v = 0; v < numVertices; v++)
            {
                const compX = bytes[vertBase + v * 4];
                const compY = bytes[vertBase + v * 4 + 1];
                const compZ = bytes[vertBase + v * 4 + 2];

                // the coordinate system in MD2 formats is different from the coordinate system in WebGL,
                // so we need to remap the axes before applying scale and translate.
                
                // MD2 coordinate system:   X-right, Y-forward, Z-up.
                // WebGL coordinate system: X-right, Y-up,      Z-toward-viewer

                // remapping: webgl.x = md2.x, webgl.y = md2.z, webgl.z = -md2.y

                positions[v * 3]     = scaleX * compX + transX;
                positions[v * 3 + 1] = scaleZ * compZ + transZ;
                positions[v * 3 + 2] = -(scaleY * compY + transY);
            }

            frames.push({ name, positions });
        }

        return frames;
    }

    parseAnimations(frames)
    {
        // MD2 does not explicitly separate frames by animations, 
        // but the animations can be inferred from the names and ordering of the frames.

        // each frame has a 16-character name such as "stand01", "stand02", "run01", "run02", etc.
        // animations are inferred by stripping the trailing number
        // consecutive frames that share the same base name form one animation sequence

        const animations = [];
        let current = null;

        for(let i = 0; i < frames.length; i++)
        {
            // strip trailing digits to get the base animation name
            const name = frames[i].name.replace(/\d+$/, "");

            if(!current || current.name !== name)
            {
                if(current) { animations.push(current); }
                
                current = { name, start: i, end: i };
            }
            else
            {
                current.end = i;
            }
        }

        if(current) { animations.push(current); }

        return animations;
    }
}
