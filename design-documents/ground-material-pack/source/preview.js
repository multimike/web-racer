import { Engine } from '@babylonjs/core/Engines/engine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';

const status = document.querySelector('#status');
const canvas = document.querySelector('#render');
try {
  const engine = new Engine(canvas, true, {preserveDrawingBuffer:true});
  const scene = new Scene(engine);
  scene.clearColor = new Color4(.065,.08,.10,1);
  const camera = new ArcRotateCamera('camera', -Math.PI/2, .70, 8.6, Vector3.Zero(), scene);
  camera.attachControl(canvas,true);
  camera.lowerBetaLimit=.08;camera.upperBetaLimit=1.45;
  camera.lowerRadiusLimit=2;camera.upperRadiusLimit=40;camera.wheelPrecision=35;
  const sun = new DirectionalLight('sun', new Vector3(-.6,-.8,-.3),scene);
  sun.diffuse=new Color3(1,.96,.89);sun.intensity=2.0;
  const fill=new HemisphericLight('fill',Vector3.Up(),scene);
  fill.diffuse=new Color3(.78,.86,1);fill.groundColor=new Color3(.2,.2,.23);fill.intensity=.65;
  const plane=CreateGround('sample',{width:4,height:4},scene);
  // Explicit tangent basis: U is +X and V is +Z for this preview plane.
  plane.setVerticesData('tangent',[1,0,0,-1,1,0,0,-1,1,0,0,-1,1,0,0,-1]);
  let active,request=0;
  const materialSelect=document.querySelector('#material');
  const repeats=document.querySelector('#repeats');
  const strength=document.querySelector('#strength');
  function texture(path,srgb) {
    const t=new Texture(path,scene,false,true,Texture.TRILINEAR_SAMPLINGMODE);
    t.gammaSpace=srgb;t.wrapU=t.wrapV=Texture.WRAP_ADDRESSMODE;
    t.anisotropicFilteringLevel=8;t.uScale=t.vScale=Number(repeats.value);
    return t;
  }
  async function select() {
    const version=++request;
    status.textContent='Loading aligned maps…';
    const slug=materialSelect.value;
    const mat=new PBRMaterial(slug,scene);
    mat.albedoTexture=texture(`${slug}/basecolor.png`,true);
    mat.bumpTexture=texture(`${slug}/normal_gl.png`,false);
    mat.bumpTexture.level=Number(strength.value);
    mat.metallicTexture=texture(`${slug}/orm.png`,false);
    mat.metallic=1; // Multiply the packed metallic channel; it is identically zero.
    mat.roughness=1;
    mat.useRoughnessFromMetallicTextureAlpha=false;
    mat.useRoughnessFromMetallicTextureGreen=true;
    mat.useMetallnessFromMetallicTextureBlue=true;
    mat.useAmbientOcclusionFromMetallicTextureRed=true;
    mat.invertNormalMapX=false;mat.invertNormalMapY=false;
    mat.environmentIntensity=0;
    plane.material=mat;
    await mat.forceCompilationAsync(plane);
    if(version!==request){mat.dispose(false,true);return;}
    active?.dispose(false,true);active=mat;
    status.textContent='PBR preview ready · 4 m per tile · drag to orbit';
    document.querySelector('#map-image').src=`${slug}/${document.querySelector('#map').value}.png`;
    document.querySelector('#repeat-image').style.backgroundImage=`url('${slug}/basecolor.png')`;
    document.querySelector('#json-link').href=`${slug}/material.json`;
    document.documentElement.dataset.previewReady='true';
  }
  function repetition(){
    const n=Number(repeats.value);
    plane.scaling.x=plane.scaling.z=n;
    camera.radius=8.6*n;camera.upperRadiusLimit=40*n;
    for(const t of active?.getActiveTextures()||[])t.uScale=t.vScale=n;
    document.querySelector('#repeat-value').textContent=`${n} × ${n}`;
  }
  repeats.addEventListener('input',repetition);
  strength.addEventListener('input',()=>{if(active?.bumpTexture)active.bumpTexture.level=Number(strength.value);document.querySelector('#strength-value').textContent=Number(strength.value).toFixed(2);});
  document.querySelector('#sun').addEventListener('input',event=>{
    const a=Number(event.target.value)*Math.PI/180;
    sun.direction=new Vector3(-Math.cos(a)*.8,-.6,-Math.sin(a)*.8).normalize();
  });
  document.querySelector('#map').addEventListener('change',event=>document.querySelector('#map-image').src=`${materialSelect.value}/${event.target.value}.png`);
  materialSelect.addEventListener('change',()=>select().catch(error=>status.textContent=String(error)));
  document.querySelector('#reset').addEventListener('click',()=>{camera.alpha=-Math.PI/2;camera.beta=.70;camera.radius=8.6*Number(repeats.value);});
  engine.runRenderLoop(()=>scene.render());
  window.addEventListener('resize',()=>engine.resize());
  select().catch(error=>{status.textContent=String(error);console.error(error);});
}catch(error){status.textContent='WebGL preview unavailable: '+error;console.error(error);}
