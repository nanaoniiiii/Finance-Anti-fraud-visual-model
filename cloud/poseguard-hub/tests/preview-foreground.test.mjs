import test from 'node:test';import assert from 'node:assert/strict';
import {previewForeground}from'../src/preview-foreground.js';
test('Native foreground survives delayed WebView hidden state; real background stops',()=>{
 assert.equal(previewForeground({isForeground:()=>true},true),true);
 assert.equal(previewForeground({isForeground:()=>false},false),false);
 assert.equal(previewForeground(undefined,true),false);
 assert.equal(previewForeground(undefined,false),true);
 assert.equal(previewForeground({isForeground:()=>{throw Error();}},true),false);
});
