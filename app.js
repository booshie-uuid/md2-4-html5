/********************************************************************************
 * MD2-4-HTML5
 * 
 * A simple MD2 model loader and viewer built with HTML5 and WebGL.
 * 
 * @author Matthew Lynch
 * @license 
 * Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)	
 *******************************************************************************/

const EXAMPLE_MODELS = [
    {
        name:     "Potator",
        modelUrl: "models/potator.md2",
        skinUrl:  "models/potator.bmp",
        credits: "Model By: ryott85@hotmail.com"
    },
    {
        name:     "Tony",
        modelUrl: "models/tony.md2",
        skinUrl:  "models/tony.bmp",
        credits: "Model By: toptenn@nis.net"
    },
    {
        name:     "Karrot",
        modelUrl: "models/karrot.md2",
        skinUrl:  "models/karrot.bmp",
        credits: "Model By: acid@rocketjump.co.uk"
    }
];

class AppViewModel
{
    constructor(canvas)
    {
        this.loader   = new MD2Loader();
        
        this.renderer = new MD2Renderer(canvas);
        this.renderer.startRenderLoop();

        this.animations        = ko.observableArray([]);
        this.selectedAnimation = ko.observable(null);
        this.isPlaying         = ko.observable(true);
        this.animSpeed         = ko.observable(10);
        this.modelLoaded       = ko.observable(false);
        this.currentFrame      = ko.observable(0);
        this.totalFrames       = ko.observable(0);
        this.logEntries        = ko.observableArray([]);

        // example models list
        this.exampleModels   = ko.observableArray(EXAMPLE_MODELS);
        this.selectedExample = ko.observable(null);

        // play button label and frame display
        this.playLabel = ko.computed(() => this.isPlaying() ? "⏸ Pause" : "▶ Play");
        this.frameDisplay = ko.computed(() => this.modelLoaded() ? `Frame ${this.currentFrame()} / ${this.totalFrames()}` : "");

        // change handlers
        this.selectedAnimation.subscribe(name => { if(name) { this.renderer.setAnimation(name); } });
        this.animSpeed.subscribe(fps => { this.renderer.setSpeed(Number(fps)); });

        // pool for changes in frame info
        setInterval(() =>
        {
            if(!this.modelLoaded()) { return; }

            const info = this.renderer.frameInfo;

            this.currentFrame(info.frame);
            this.totalFrames(info.totalFrames);

            return;
        }, 50);

        this.log("READY! Load an .md2 file to begin...");
    }


    // LOGGING /////////////////////////////////////////////////////////////

    log(text, type = "info")
    {
        const now  = new Date();
        const time = now.toTimeString().slice(0, 8);

        this.logEntries.push({ time, text, type });

        // auto scroll the console to last entry
        setTimeout(() =>
        {
            const body = document.querySelector(".console-body");

            if(body) { body.scrollTop = body.scrollHeight; }

            return;
        }, 0);
    }

    clearLog()
    {
        this.logEntries([]);
    }

    // LOADERS /////////////////////////////////////////////////////////////

    loadModelFromBuffer(buffer, label)
    {
        const model = this.loader.parse(buffer);
        this.renderer.loadModel(model);

        const anims = model.animations.map(a => a.name);
        this.animations(anims);
        
        // select first animation by default
        if(anims.length) { this.selectedAnimation(anims[0]); }

        this.modelLoaded(true);

        this.log(`Loaded Model: ${label}`);
        this.log(`${model.header.numFrames} frames || ${model.animations.length} animations || ${model.header.numTriangles} triangles`);
    }

    loadSkinFromImage(img, label)
    {
        this.renderer.loadSkinTexture(img);

        if(label) { this.log(`Loaded Skin: ${label}`); }
    }

    loadExample()
    {
        const example = this.selectedExample();
        
        // abort if no example selected
        if(!example) { return; }

        this.log(`Fetching "${example.name}"...`);

        const modelPromise = fetch(example.modelUrl).then(r => 
        { 
            if(!r.ok) { throw new Error(`Model fetch failed: ${r.status}`); }

            return r.arrayBuffer(); 
        });

        const skinPromise = new Promise((resolve, reject) =>
        {
            const img = new Image();

            img.crossOrigin = "anonymous";
            img.onload  = () => resolve(img);
            img.onerror = () => reject(new Error("Skin image failed to load"));
            img.src = example.skinUrl;
        });

        Promise.all([modelPromise, skinPromise])
        .then(([buffer, img]) => 
        {
            this.loadModelFromBuffer(buffer, example.name);
            this.loadSkinFromImage(img);

            if(example.credits)
            {
                this.log(example.credits);
            }
        })
        .catch(err =>
        {
            this.log(err.message, "error");
            console.error(err);
        });
    }

    // FILE UPLOAD HANDLERS ////////////////////////////////////////////////

    onModelFile(_, event)
    {
        const file = event.target.files[0];

        // abort if no file found
        if(!file) { return; }
        
        this.log(`Loading ${file.name}...`);

        const reader = new FileReader();
        
        // set up load and error handlers
        reader.onload = (e) =>
        {
            try
            {
                this.loadModelFromBuffer(e.target.result, file.name);
            }
            catch (err)
            {
                this.log(err.message, "error");
                console.error(err);
            }
        };

        reader.onerror = () => this.log("Failed to read file.", "error");
        
        // read the file
        reader.readAsArrayBuffer(file);

        event.target.value = "";
    }

    onSkinFile(_, event)
    {
        const file = event.target.files[0];

        // abort if no file found
        if(!file) { return; }

        const url = URL.createObjectURL(file);
        const img = new Image();

        // set up load and error handlers
        img.onload = () =>
        {
            this.loadSkinFromImage(img, file.name);
            URL.revokeObjectURL(url);
        };

        img.onerror = () =>
        {
            this.log("Failed to load skin image.", "error");
            URL.revokeObjectURL(url);
        };

        // load the image
        img.src = url;

        event.target.value = "";
    }

    // ANIMATION CONTROLS /////////////////////////////////////////////////

    togglePlay()
    {
        const next = !this.isPlaying();
        this.isPlaying(next);

        if(next) { this.renderer.play(); }
        else     { this.renderer.pause(); }
    }

    selectAnimation(name)
    {
        this.selectedAnimation(name);
    }
}

// INITIALISATION //////////////////////////////////////////////////////
document.addEventListener("DOMContentLoaded", () =>
{
    const canvas = document.getElementById("glCanvas");
    const vm = new AppViewModel(canvas);
    
    ko.applyBindings(vm);
});
