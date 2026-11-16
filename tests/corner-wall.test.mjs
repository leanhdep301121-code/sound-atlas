import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
const model=JSON.parse(readFileSync(new URL('../dist/assets/model/second-floor.json',import.meta.url),'utf8'));
test('the CAD southeast return is a full-height wall instead of an opening',()=>{
 const source=model.meshes.find(m=>m.material==='plaster');
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(source.positions,3));geometry.setIndex(source.indices);
 const material=new THREE.MeshBasicMaterial({side:THREE.DoubleSide});const mesh=new THREE.Mesh(geometry,material);mesh.updateMatrixWorld();
 for(const height of [.3,1.6,3.1]){
  const hits=new THREE.Raycaster(new THREE.Vector3(18,height,-3.4),new THREE.Vector3(-1,0,0)).intersectObject(mesh);
  assert.ok(hits.length);assert.ok(Math.abs(hits[0].point.x-17.15702)<.0001);
 }
 assert.deepEqual(model.metadata.cornerWallCorrection.sourceIds,[37838,37839]);
 geometry.dispose();material.dispose();
});
