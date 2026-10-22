import test from'node:test';
import assert from'node:assert/strict';
import{deflateSync}from'node:zlib';
import{clientAssetBank,staticSymbol}from'../client-assets.mjs';
test('owned icon lookup preserves real item gfx and the original ordered altere index',()=>{
  const catalog={items:[{id:39,type:1,gfx:1}],monsters:[{id:9022,gfx_id:1279},{id:9321,gfx_id:1360}]};
  assert.equal(clientAssetBank('/assets/template/images/items/39.svg',catalog),'items/1/1.swf');
  assert.equal(clientAssetBank('/assets/template/images/alteres/2.svg',catalog),'artworks/big/1279.swf');
  assert.equal(clientAssetBank('/assets/template/images/alteres/9321.svg',catalog),'artworks/big/1360.swf');
  assert.equal(clientAssetBank('/assets/template/images/items/9999.svg',catalog),null);
  assert.equal(clientAssetBank('/assets/items/../private.svg',catalog),null);
});
test('static symbol selection reads only SWF tags and chooses an available staticR pose',()=>{
  const assets=Buffer.concat([Buffer.from([2,0,100,0]),Buffer.from('staticL\0'),Buffer.from([108,0]),Buffer.from('staticR\0')]);
  const tag=Buffer.alloc(2);tag.writeUInt16LE((56<<6)|assets.length);
  const file=Buffer.concat([Buffer.from('FWS'),Buffer.from([8]),Buffer.alloc(4),Buffer.from([8,0,0,12,1,0]),tag,assets,Buffer.from([0,0])]);file.writeUInt32LE(file.length,4);
  assert.deepEqual(staticSymbol(file),{id:108,name:'staticR'});
  const compressed=Buffer.concat([Buffer.from('CWS'),file.subarray(3,8),deflateSync(file.subarray(8))]);assert.deepEqual(staticSymbol(compressed),{id:108,name:'staticR'});
  assert.equal(staticSymbol(Buffer.from('invalid')),null);
});
