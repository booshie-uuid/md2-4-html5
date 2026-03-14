/********************************************************************************
 * mat4.js
 * 
 * A basic utility class for the most common 4x4 matrix operations used in 
 * 3D graphics, following WebGL naming and structural conventions.
 * 
 * @author Matthew Lynch
 * @license 
 * Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)	
 *******************************************************************************/

class Mat4
{
    static identity()
    {
        return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    }

    static multiply(a, b)
    {
        // WebGL stores matrices in element [row + col * 4] format
        const out = new Float32Array(16);
        
        for(let row = 0; row < 4; row++)
        {
            for(let col = 0; col < 4; col++)
            {
                let sum = 0;
                
                for(let k = 0; k < 4; k++)
                { 
                    sum += a[row + k * 4] * b[k + col * 4];
                }
                
                out[row + col * 4] = sum;
            }
        }
        
        return out;
    }

    static perspective(fovY, aspect, near, far)
    {
        // standard perspective matrices map [near, far] to [0, 1], but we want to map it to [-1, 0]
        // so that vertices behind the near plane still get a valid depth value

        const focalLen      = 1.0 / Math.tan(fovY / 2);
        const invDepthRange = 1.0 / (near - far);

        // perspective projection matrix:
        // [ focalLen / aspect, 0,        0,                              0 ]
        // [ 0,                 focalLen, 0,                              0 ]
        // [ 0,                 0,        (far + near) * invDepthRange,  -1 ]
        // [ 0,                 0,        2 * far * near * invDepthRange, 0 ]
        const m = new Float32Array(16);
        m[0]  = focalLen / aspect;
        m[5]  = focalLen;
        m[10] = (far + near) * invDepthRange;
        m[11] = -1;
        m[14] = 2.0 * far * near * invDepthRange;

        return m;
    }

    static lookAt(eye, center, up)
    {
        const ex = eye[0], ey = eye[1], ez = eye[2];
        const cx = center[0], cy = center[1], cz = center[2];

        // forward vector
        // normalised direction from eye to centre
        let fwdX = cx - ex, fwdY = cy - ey, fwdZ = cz - ez;
        let len = Math.hypot(fwdX, fwdY, fwdZ);
        
        fwdX /= len; fwdY /= len; fwdZ /= len;

        // right vector
        // cross product of forward and world up
        let rightX = fwdY * up[2] - fwdZ * up[1];
        let rightY = fwdZ * up[0] - fwdX * up[2];
        let rightZ = fwdX * up[1] - fwdY * up[0];
        
        len = Math.hypot(rightX, rightY, rightZ);
        rightX /= len; rightY /= len; rightZ /= len;

        // local up vector
        // corrected so that the three axes are orthogonal
        // cross product of right and forward
        const upX = rightY * fwdZ - rightZ * fwdY;
        const upY = rightZ * fwdX - rightX * fwdZ;
        const upZ = rightX * fwdY - rightY * fwdX;

        const m = new Float32Array(16);
        m[0] = rightX; m[4] = rightY; m[8]  = rightZ; m[12] = -(rightX * ex + rightY * ey + rightZ * ez);
        m[1] = upX;    m[5] = upY;    m[9]  = upZ;    m[13] = -(upX * ex    + upY * ey    + upZ * ez);
        m[2] = -fwdX;  m[6] = -fwdY;  m[10] = -fwdZ;  m[14] =  (fwdX * ex   + fwdY * ey   + fwdZ * ez);
        m[3] = 0;      m[7] = 0;      m[11] = 0;      m[15] = 1;
        
        return m;
    }

    static rotateY(a)
    {
        const cos = Math.cos(a);
        const sin = Math.sin(a);
     
        // rotation matrix for rotating around the Y axis:
        // [  cos, 0, sin, 0 ]
        // [  0,   1, 0,   0 ]
        // [ -sin, 0, cos, 0 ]
        // [  0,   0, 0,   1 ]
        const m = Mat4.identity();
        m[0] = cos; m[8] = sin; m[2] = -sin; m[10] = cos;
        
        return m;
    }

    static rotateX(a)
    {
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        
        // rotation matrix for rotating around the X axis:
        // [ 1, 0,   0,    0 ]
        // [ 0, cos, -sin, 0 ]
        // [ 0, sin, cos,  0 ] 
        // [ 0, 0,   0,    1 ]
        const m = Mat4.identity();
        m[5] = cos; m[9] = -sin; m[6] = sin; m[10] = cos;
        
        return m;
    }
}