import {GLTFLoader} from './assets/vendor/loaders/GLTFLoader.js';
import {MeshoptDecoder} from './assets/vendor/meshopt_decoder.mjs';
import {MODEL_ASSET,COMPRESSED_MODEL_ASSET} from './model-asset.js';

// Both filenames contain a content hash, so immutable browser caching is safe.
export async function loadSpatialModel({fetcher=fetch,timeout=60000}={}) {
  const compressed=typeof DecompressionStream==='function';
  const url=new URL(compressed?COMPRESSED_MODEL_ASSET:MODEL_ASSET,import.meta.url);
  for(let attempt=0;attempt<2;attempt++){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeout);
    try{
      const response=await fetcher(url,{signal:controller.signal,cache:attempt?'reload':'default'});
      if(!response.ok)throw new Error('Model HTTP '+response.status);
      let buffer=await response.arrayBuffer();
      const magic=new Uint8Array(buffer,0,Math.min(2,buffer.byteLength));
      // If HTTP already decompressed the resource, do not decompress it twice.
      if(magic[0]===0x1f&&magic[1]===0x8b){
        buffer=await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      }
      const gltf=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer,new URL('./',url).href);
      const definitions=gltf.parser.json.extras?.materialDefinitions;
      if(!Array.isArray(definitions)||!gltf.scene.children.length)throw new Error('Invalid model');
      return {materials:definitions,meshes:gltf.scene.children};
    }catch(error){
      if(attempt===1)throw new Error('三维模型未能下载或解码，请检查网络后点击重新加载。',{cause:error});
    }finally{clearTimeout(timer);}
  }
}
