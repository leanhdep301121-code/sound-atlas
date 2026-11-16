import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadSpatialModel} from '../dist/spatial-model.js';
import {MODEL_ASSET,COMPRESSED_MODEL_ASSET} from '../dist/model-asset.js';
const original=JSON.parse(await readFile(new URL('../dist/assets/model/second-floor.json',import.meta.url)));
async function fixture(compressed=true){
 const bytes=await readFile(new URL('../dist/'+(compressed?COMPRESSED_MODEL_ASSET:MODEL_ASSET),import.meta.url));
 return loadSpatialModel({fetcher:async()=>new Response(bytes)});
}
test('compressed GLB retains every mesh, vertex, normal, UV and oriented triangle',async()=>{
 const model=await fixture();assert.deepEqual(model.materials,original.materials);assert.equal(model.meshes.length,original.meshes.length);
 for(const record of original.meshes){
  const mesh=model.meshes.find(m=>m.userData.materialId===record.material);assert.ok(mesh,record.material);
  for(const [attribute,key] of [['position','positions'],['normal','normals'],['uv','uvs']]){
   assert.deepEqual(mesh.geometry.getAttribute(attribute).array,new Float32Array(record[key]),record.material+' '+attribute);
  }
  const indices=mesh.geometry.index.array;assert.equal(indices.length,record.indices.length);
  for(let i=0;i<indices.length;i+=3){
   const actual=Array.from(indices.slice(i,i+3)),expected=record.indices.slice(i,i+3);
   assert.ok([0,1,2].some(shift=>actual.every((v,j)=>v===expected[(j+shift)%3])),record.material+' triangle '+i/3);
  }
  mesh.geometry.dispose();mesh.material.dispose();
 }
});
test('loader accepts already decompressed HTTP responses',async()=>{
 const model=await fixture(false);assert.equal(model.meshes.length,13);
 model.meshes.forEach(m=>{m.geometry.dispose();m.material.dispose();});
});
test('model failures retry once and remain actionable',async()=>{
 let requests=0;
 await assert.rejects(loadSpatialModel({fetcher:async()=>{requests++;throw new Error('offline');}}),/检查网络/);
 assert.equal(requests,2);
});
