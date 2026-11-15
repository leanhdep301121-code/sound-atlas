import test from 'node:test';
import assert from 'node:assert/strict';
import {beginSelectionGesture,moveSelectionGesture,selectionFromGesture} from '../dist/collect/collect-manage.mjs';

test('clicking or tiny pointer movement does not become a selection',()=>{
  const down=beginSelectionGesture(100,10000,true);
  assert.equal(down.following,true);
  assert.equal(selectionFromGesture(down),null);
  const tiny=moveSelectionGesture(down,103,12000);
  assert.equal(tiny.selecting,false);
  assert.equal(selectionFromGesture(tiny),null);
});
test('only a real horizontal selection pauses following and creates a bounded interval',()=>{
  const dragged=moveSelectionGesture(beginSelectionGesture(100,10000,true),130,20000);
  assert.equal(dragged.selecting,true);
  assert.deepEqual(selectionFromGesture(dragged),{start:10000,end:20000});
  const reverse=moveSelectionGesture(beginSelectionGesture(130,20000,false),100,10000);
  assert.equal(reverse.following,false);
  assert.deepEqual(selectionFromGesture(reverse),{start:10000,end:20000});
});
test('dragging back to the starting point does not leave an empty locked selection',()=>{
  const down=beginSelectionGesture(100,10000,true);
  const returned=moveSelectionGesture(moveSelectionGesture(down,130,20000),100,10000);
  assert.equal(selectionFromGesture(returned),null);
  assert.equal(returned.following,true);
});
