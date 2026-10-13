import {expect,it} from 'vitest';
import {chromium} from '@playwright/test';
import {projectExpectedAssets,renderWorkflowDiagram} from '@signal-room/workflow-spaces';
import {bridgeWorkflowDiagram} from '@signal-room/workflow-space-api/server';
import {createContentDeployment} from '../src/spaces/content-method.js';

const browserTest=process.env.WORKFLOW_TEST_CHROMIUM_PATH?it:it.skip;
browserTest('opens the research and draft expected contracts directly from the Archify method graph',async()=>{
  const deployment=createContentDeployment({runner:{async run(){throw new Error('Fixture must not execute');}},
    models:{worker:{model:'fixture',reasoningEffort:'high'},judge:{model:'fixture',reasoningEffort:'high'}}});
  const candidate=deployment.candidate();
  const entry=candidate.version.entrypoints.content!;
  const expected=projectExpectedAssets(entry,candidate.presentation);
  const research=expected.assets.find(asset=>asset.source.kind==='node-output'&&asset.source.nodeId==='researcher');
  const draft=expected.assets.find(asset=>asset.source.kind==='node-output'&&asset.source.nodeId==='author');
  expect(research).toBeDefined();expect(draft).toBeDefined();
  const html=bridgeWorkflowDiagram(await renderWorkflowDiagram({entry,presentation:candidate.presentation,detailBase:'/'}),
    [...entry.process!.nodes.map(node=>node.id),...expected.assets.map(asset=>asset.id)]);
  const browser=await chromium.launch({headless:true,executablePath:process.env.WORKFLOW_TEST_CHROMIUM_PATH});
  try{
    const page=await browser.newPage({viewport:{width:1500,height:588}});
    const errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(html,{waitUntil:'load'});
    if(process.env.WORKFLOW_TEST_GRAPH_SCREENSHOT)await page.screenshot({path:process.env.WORKFLOW_TEST_GRAPH_SCREENSHOT});
    await page.evaluate(()=>{
      (window as typeof window & {graphSelections:string[]}).graphSelections=[];
      window.addEventListener('message',event=>{
        if(event.data?.type==='workflow-node-select')
          (window as typeof window & {graphSelections:string[]}).graphSelections.push(event.data.nodeId);
      });
    });
    await page.locator(`.diagram-container svg [data-node-id="${research!.id}"]`).click();
    await page.waitForFunction(id=>(window as typeof window & {graphSelections:string[]}).graphSelections.includes(id),research!.id);
    await page.evaluate(id=>window.postMessage({type:'space-node-focus',nodeId:id},'*'),research!.id);
    await page.locator('.diagram-container svg [data-node-id="researcher"]').click();
    await page.waitForFunction(()=>(window as typeof window & {graphSelections:string[]}).graphSelections.includes('researcher'));
    await page.evaluate(()=>window.postMessage({type:'space-node-focus',nodeId:'researcher'},'*'));
    expect(await page.locator('.diagram-container > svg').getAttribute('data-focus-active')).toBe('researcher');
    await page.evaluate(()=>window.postMessage({type:'space-node-focus',nodeId:null},'*'));
    await page.waitForFunction(()=>!document.querySelector('.diagram-container svg')?.hasAttribute('data-focus-active'));
    const cleared=await page.evaluate(()=>{
      const svg=document.querySelector('.diagram-container svg') as SVGSVGElement;
      return {duration:getComputedStyle(svg).transitionDuration,transform:getComputedStyle(svg).transform,
        transaction:document.querySelector('.diagram-container')?.getAttribute('data-camera-transaction')??null,
        related:document.querySelectorAll('.diagram-container svg [data-handoff-related],.diagram-container svg [data-data-active]').length};
    });
    expect(cleared).toEqual({duration:'0s',transform:'matrix(1, 0, 0, 1, 0, 0)',transaction:null,related:0});
    await page.locator(`.diagram-container svg [data-node-id="${draft!.id}"]`).click({timeout:5000});
    await page.waitForFunction(id=>(window as typeof window & {graphSelections:string[]}).graphSelections.at(-1)===id,draft!.id);
    const researchNode=page.locator(`.diagram-container svg [data-node-id="${research!.id}"]`);
    await researchNode.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(id=>(window as typeof window & {graphSelections:string[]}).graphSelections.filter(value=>value===id).length===2,research!.id);
    expect(errors).toEqual([]);
  }finally{await browser.close();}
},30_000);

browserTest('frames a producer reached from an expected asset inside the embedded canvas',async()=>{
  const deployment=createContentDeployment({runner:{async run(){throw new Error('Fixture must not execute');}},
    models:{worker:{model:'fixture',reasoningEffort:'high'},judge:{model:'fixture',reasoningEffort:'high'}}});
  const candidate=deployment.candidate();
  const entry=candidate.version.entrypoints.content!;
  const research=projectExpectedAssets(entry,candidate.presentation).assets.find(asset=>asset.source.kind==='node-output'&&asset.source.nodeId==='researcher')!;
  const expected=projectExpectedAssets(entry,candidate.presentation);
  const html=bridgeWorkflowDiagram(await renderWorkflowDiagram({entry,presentation:candidate.presentation,detailBase:'/'}),
    [...entry.process!.nodes.map(node=>node.id),...expected.assets.map(asset=>asset.id)]);
  const browser=await chromium.launch({headless:true,executablePath:process.env.WORKFLOW_TEST_CHROMIUM_PATH});
  try{
    // Matches the graph iframe beside the 360 px inspector at 1728 × 960.
    const page=await browser.newPage({viewport:{width:1138,height:588}});
    await page.setContent(html,{waitUntil:'load'});
    await page.locator(`.diagram-container > svg [data-node-id="${research.id}"]`).click();
    await page.waitForFunction(()=>!document.querySelector('.diagram-container')?.hasAttribute('data-camera-transaction'));
    await page.evaluate(id=>window.postMessage({type:'space-node-focus',nodeId:id},'*'),research.id);
    await page.evaluate(()=>window.postMessage({type:'space-node-focus',nodeId:'researcher'},'*'));
    await page.waitForFunction(()=>document.querySelector('.diagram-container > svg')?.getAttribute('data-focus-active')==='researcher');
    await page.waitForFunction(()=>!document.querySelector('.diagram-container')?.hasAttribute('data-camera-transaction'));
    const bounds=await page.evaluate(assetId=>{
      const canvas=document.querySelector('.diagram-container')!.getBoundingClientRect();
      const visible={left:Math.max(0,canvas.left),top:Math.max(0,canvas.top),right:Math.min(innerWidth,canvas.right),bottom:Math.min(innerHeight,canvas.bottom)};
      const rect=(id:string)=>{
        const box=document.querySelector(`.diagram-container > svg [data-node-id="${id}"]`)!.getBoundingClientRect();
        return {left:box.left,top:box.top,right:box.right,bottom:box.bottom};
      };
      return {visible,producer:rect('researcher'),output:rect(assetId)};
    },research.id);
    for(const node of [bounds.producer,bounds.output]){
      expect(node.left).toBeGreaterThanOrEqual(bounds.visible.left);
      expect(node.top).toBeGreaterThanOrEqual(bounds.visible.top);
      expect(node.right).toBeLessThanOrEqual(bounds.visible.right);
      expect(node.bottom).toBeLessThanOrEqual(bounds.visible.bottom);
    }
  }finally{await browser.close();}
},30_000);
