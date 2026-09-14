import { describe, expect, test } from 'bun:test';
import { respondToNativeRequest } from '../src/web-session/approvals';
const base={active:true,toolAccess:'all' as const,allowedApps:[],signal:new AbortController().signal};
const confirmation={serverName:'cua_repl',mode:'form',message:'Allow this tool?',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',connector_id:'computer-use',tool_name:'scroll',tool_params:{app:'com.google.Chrome'}}};
describe('web delegated native approvals',()=>{
 test('allows native CUA interactions and other native MCP tools in explicitly enabled all mode',async()=>{
  for(const p of [confirmation,{...confirmation,_meta:{...confirmation._meta,tool_name:'click'}},{...confirmation,serverName:'another_mcp',_meta:{codex_approval_kind:'mcp_tool_call',tool_name:'update_file'}}])
   expect(await respondToNativeRequest('mcpServer/elicitation/request',p,base)).toMatchObject({action:'accept'});
 });
 test('configured Chrome authorization includes interactions but excludes other apps',async()=>{
  const scoped={...base,toolAccess:'configured' as const,allowedApps:['com.google.Chrome']};
  expect(await respondToNativeRequest('mcpServer/elicitation/request',confirmation,scoped)).toMatchObject({action:'accept'});
  expect(await respondToNativeRequest('mcpServer/elicitation/request',{...confirmation,_meta:{...confirmation._meta,tool_params:{app:'com.apple.Terminal'}}},scoped)).toMatchObject({action:'decline'});
 });
 test('does not consent to inactive, arbitrary empty forms, fields, or login URLs',async()=>{
  expect(await respondToNativeRequest('mcpServer/elicitation/request',confirmation,{...base,active:false})).toMatchObject({action:'decline'});
  for(const p of [{...confirmation,_meta:{}},{...confirmation,requestedSchema:{type:'object',properties:{answer:{type:'string'}}}},{...confirmation,mode:'url',url:'https://example.com'}])
   expect(await respondToNativeRequest('mcpServer/elicitation/request',p,base)).toMatchObject({action:'decline'});
 });
 test('uses native command and file decisions only for an active authorized operation',async()=>{
  for(const method of ['item/commandExecution/requestApproval','item/fileChange/requestApproval']){
   expect(await respondToNativeRequest(method,{},base)).toEqual({decision:'accept'});
   await expect(respondToNativeRequest(method,{}, {...base,active:false})).rejects.toThrow('explicit operator');
   await expect(respondToNativeRequest(method,{}, {...base,toolAccess:'configured'})).rejects.toThrow('explicit operator');
  }
  await expect(respondToNativeRequest('item/commandExecution/requestApproval',{availableDecisions:['decline']},base)).rejects.toThrow('does not offer accept');
 });
 test('permission grants include only the requested permission profile and last one turn',async()=>{
  const permissions={network:{enabled:true}};
  expect(await respondToNativeRequest('item/permissions/requestApproval',{permissions},base)).toEqual({permissions,scope:'turn'});
 });
 test('forwards actual input instead of fabricating form answers',async()=>{
  let received:any;
  const result=await respondToNativeRequest('mcpServer/elicitation/request',{...confirmation,requestedSchema:{type:'object',properties:{answer:{type:'string'}},required:['answer']}},{...base,requestInput:async p=>{received=p;return {action:'accept',content:{answer:'actual user answer'}};}});
  expect(received.requestedSchema.required).toEqual(['answer']);
  expect(result).toEqual({action:'accept',content:{answer:'actual user answer'}});
 });
 test('forwards question tools and preserves actual answers',async()=>{
  const result=await respondToNativeRequest('item/tool/requestUserInput',{questions:[{id:'choice',header:'Choice',question:'Choose?',options:[{label:'One',description:'First'}]}]}, {...base,requestInput:async()=>({action:'accept',content:{choice:'One'}})});
  expect(result).toEqual({answers:{choice:{answers:['One']}}});
 });
});

test('does not approve after cancellation or fabricate missing question answers',async()=>{
 await expect(respondToNativeRequest('mcpServer/elicitation/request',confirmation,{...base,signal:AbortSignal.abort()})).rejects.toThrow();
 await expect(respondToNativeRequest('item/commandExecution/requestApproval',{}, {...base,signal:AbortSignal.abort()})).rejects.toThrow();
 await expect(respondToNativeRequest('item/tool/requestUserInput',{questions:[{id:'answer',header:'Answer',question:'Why?'}]}, {...base,requestInput:async()=>({action:'accept'})})).rejects.toThrow('did not supply');
});
