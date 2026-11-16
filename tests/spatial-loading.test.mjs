import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function textureFunction(loader){
 const source=readFileSync(new URL('../dist/spatial-view.js',import.meta.url),'utf8');
 const start=source.indexOf('    async function loadTexture(');
 const end=source.indexOf('\n    for (const definition',start);
 const body=source.slice(start,end).replaceAll('import.meta.url',JSON.stringify('https://example.test/spatial-view.js'));
 const context=vm.createContext({URL,textureCache:new Map(),textureRequests:new Map(),textureFailures:0,textureLoader:loader,disposed:false,renderer:{capabilities:{getMaxAnisotropy:()=>8}},THREE:{RepeatWrapping:1,SRGBColorSpace:2,NoColorSpace:3},setTimeout,clearTimeout});
 return vm.runInContext(body+';loadTexture',context);
}
test('a failed optional texture cannot reject the whole spatial model',async()=>{
 const load=textureFunction({loadAsync:async()=>{throw new Error('connection closed');}});
 assert.equal(await load('floor.jpg'),null);
});

test('one transient texture failure retries and shared material maps are downloaded once',async()=>{
 let calls=0;const texture={dispose(){throw new Error('should remain alive');}};
 const load=textureFunction({loadAsync:async()=>{calls++;if(calls===1)throw new Error('temporary');return texture;}});
 const [a,b]=await Promise.all([load('floor.jpg'),load('floor.jpg')]);
 assert.equal(a,texture);assert.equal(b,texture);assert.equal(calls,2);
 assert.equal(texture.colorSpace,3);
});
test('critical model JSON retries network errors but eventually provides an actionable failure',async()=>{
 const source=readFileSync(new URL('../dist/spatial-view.js',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('async function readJson('),source.indexOf('\nfunction materialColor'));
 let calls=0;
 const context=vm.createContext({AbortController,setTimeout,clearTimeout,fetch:async()=>{calls++;throw new Error('offline');}});
 const read=vm.runInContext(body+';readJson',context);
 await assert.rejects(read('model.json','三维模型'),/检查网络/);assert.equal(calls,2);
 context.fetch=async()=>({ok:true,json:async()=>({meshes:[1]})});
 assert.equal((await read('model.json','三维模型')).meshes.length,1);
});
