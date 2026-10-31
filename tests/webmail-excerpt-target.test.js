const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const vm = require('node:vm');
const webmail = require('../webmail.js');

const fixtures = [
  {name:'QQ', url:'https://mail.qq.com/cgi-bin/readmail?sid=synthetic&mailid=one',
    html:'<h1 id="subject">Test mail</h1><span id="fromaddr">hr@example.test</span><span id="mail_date">2026-10-31</span><div id="mailContentContainer">Body</div>',
    fields:['#subject','#fromaddr','#mail_date','#mailContentContainer'], body:'#mailContentContainer'},
  ...['163','126'].map(name=>({name,url:`https://mail.${name}.com/js6/main.jsp?sid=synthetic`,
    html:'<div class="nui-read-header"><h1 class="nui-read-title">Test mail</h1><span class="nui-addr-email">hr@example.test</span><span class="nui-read-time">2026-10-31</span></div><div class="nui-read-body">Body</div>',
    fields:['.nui-read-title','.nui-addr-email','.nui-read-time','.nui-read-body'],body:'.nui-read-body'})),
];
const documentFor = f => new JSDOM(f.html,{url:f.url}).window.document;
const unavailable = async()=>new Response('Unavailable',{status:503});

for (const fixture of fixtures) test(`${fixture.name}: reusable excerpt targets reject same-URL changes and replaced reading nodes`,async()=>{
  for (const mutate of [
    ...fixture.fields.map(selector=>d=>{d.querySelector(selector).textContent='Other mail';}),
    d=>{const body=d.querySelector(fixture.body);body.replaceWith(body.cloneNode(true));},
    d=>{d.body.appendChild(d.querySelector(fixture.body).cloneNode(true));},
  ]) {
    const d=documentFor(fixture);let downloads=0;
    const proposal=await webmail.capture(d,async()=>{downloads++;return unavailable();});
    assert.equal(proposal.status,'excerpt_offer'); assert.ok(proposal.target);
    const capturedDownloads=downloads;
    assert.equal(webmail.validateTarget(d,proposal.target,false).status,'current');
    assert.equal(webmail.validateTarget(d,proposal.target,false).status,'current');
    assert.equal(downloads,capturedDownloads,'checks never fetch the original again');
    const before=d.location.href;mutate(d);assert.equal(d.location.href,before);
    assert.equal(webmail.validateTarget(d,proposal.target,false).status,'changed');
    d.documentElement.innerHTML=new JSDOM(fixture.html).window.document.documentElement.innerHTML;
    assert.equal(webmail.validateTarget(d,proposal.target,false).status,'changed');
  }
});

test('nested QQ readers bind to the requesting top document and reject iframe reloads or source URL changes',async()=>{
  for (const replace of [false,true]) {
    const child=documentFor(fixtures[0]);
    const parent=new JSDOM('<iframe></iframe>',{url:'https://mail.qq.com/'}).window.document;
    const frame=parent.querySelector('iframe');
    Object.defineProperty(frame,'contentDocument',{value:child,configurable:true});
    const proposal=await webmail.capture(parent,unavailable);
    assert.equal(proposal.status,'excerpt_offer');
    assert.equal(webmail.validateTarget(parent,proposal.target,false).status,'current');
    assert.equal(webmail.validateTarget(child,proposal.target,false).status,'changed','child cannot reuse the top-level target');
    if(replace) Object.defineProperty(frame,'contentDocument',{value:documentFor(fixtures[0]),configurable:true});
    else child.defaultView.history.replaceState({},'','/cgi-bin/readmail?sid=other-account&mailid=one');
    assert.equal(webmail.validateTarget(parent,proposal.target,false).status,'changed');
  }
});

test('modern QQ same-text mail switches are rejected by their native visible IDs',async()=>{
  const d=new JSDOM('<div class="mail-list-page-reader-body" data-mailid="one"><h1 class="mail-detail-subject">Same subject</h1><div class="mail-detail-basic mail-detail-sender">HR</div><div class="mail-detail-content">Same body</div></div>',{url:'https://wx.mail.qq.com/home/index?sid=synthetic'}).window.document;
  const proposal=await webmail.capture(d,unavailable,async()=>({status:'unavailable'}));
  assert.equal(proposal.status,'excerpt_offer');
  assert.equal(webmail.validateTarget(d,proposal.target,false).status,'current');
  d.querySelector('[data-mailid]').setAttribute('data-mailid','two');
  assert.equal(webmail.validateTarget(d,proposal.target,false).status,'changed');
});

test('non-Gmail targets are discarded on cancellation, navigation, and the next capture',async()=>{
  for(const fixture of fixtures) {
    const d=documentFor(fixture);
    const first=await webmail.capture(d,unavailable);
    const next=await webmail.capture(d,unavailable);
    assert.equal(webmail.validateTarget(d,first.target,false).status,'changed');
    assert.equal(webmail.validateTarget(d,next.target,false).status,'current');
    webmail.discardTarget(d,next.target);
    assert.equal(webmail.validateTarget(d,next.target,false).status,'changed');
    const navigated=await webmail.capture(d,unavailable);
    d.defaultView.dispatchEvent(new d.defaultView.Event('pagehide'));
    assert.equal(webmail.validateTarget(d,navigated.target,false).status,'changed');
  }
});

test('QQ, 163 and 126 originals bind a one-use final target after the download',async()=>{
  const raw=Buffer.from('From: hr@example.test\r\nSubject: Original\r\nMessage-ID: <guard@example.test>\r\n\r\nBody');
  for(const fixture of fixtures) {
    for(const changed of [false,true]) {
      const d=documentFor(fixture);
      const toolbar=d.createElement('div');toolbar.className='nui-toolbar';
      toolbar.innerHTML='<a href="/js6/read/readdata.jsp?sid=synthetic&mid=one&mode=download">下载邮件</a>';d.body.prepend(toolbar);
      const original=await webmail.capture(d,async()=>new Response(raw));
      assert.equal(original.status,'original'); assert.ok(original.target);
      if(changed) d.querySelector(fixture.body).replaceWith(d.querySelector(fixture.body).cloneNode(true));
      assert.equal(webmail.validateTarget(d,original.target).status,changed?'changed':'current');
      assert.equal(webmail.validateTarget(d,original.target).status,'changed');
    }
  }
});

test('unexpected DOM failures during target checks return changed and release reusable snapshots',async()=>{
  const d=documentFor(fixtures[0]);
  const proposal=await webmail.capture(d,unavailable);
  const original=d.querySelectorAll;
  d.querySelectorAll=()=>{throw new Error('reading surface unavailable');};
  assert.doesNotThrow(()=>assert.equal(webmail.validateTarget(d,proposal.target,false).status,'changed'));
  d.querySelectorAll=original;
  assert.equal(webmail.validateTarget(d,proposal.target,false).status,'changed');
});

test('content-script validation messages always answer once on DOM errors and allow a fresh capture',async t=>{
  for(const type of ['WEBMAIL_CHECK','WEBMAIL_VALIDATE']) {
    const f=fixtures[0],dom=new JSDOM(f.html,{url:f.url,runScripts:'outside-only'});t.after(()=>dom.window.close());
    const win=dom.window;let listener;
    win.fetch=unavailable;win.TextEncoder=TextEncoder;
    win.chrome={runtime:{id:'own',getURL:file=>'chrome-extension://own/'+file,onMessage:{addListener:fn=>{listener=fn;}}}};
    vm.runInContext(fs.readFileSync('webmail.js','utf8'),dom.getInternalVMContext());
    const proposal=await win.ResumeProWebmail.capture(win.document,unavailable);
    const original=win.document.querySelectorAll;
    win.document.querySelectorAll=()=>{throw new Error('DOM read failed');};
    const replies=[];
    assert.equal(listener({type,target:proposal.target},{id:'own',url:'chrome-extension://own/sidepanel.html'},reply=>replies.push(reply)),false);
    assert.equal(replies.length,1);assert.equal(replies[0].status,'changed');
    win.document.querySelectorAll=original;
    assert.equal(win.ResumeProWebmail.validateTarget(win.document,proposal.target,false).status,'changed');
    const fresh=await win.ResumeProWebmail.capture(win.document,unavailable);
    assert.equal(fresh.status,'excerpt_offer');
    assert.equal(win.ResumeProWebmail.validateTarget(win.document,fresh.target,false).status,'current');
    const discarded=[];
    assert.equal(listener({type:'WEBMAIL_DISCARD',target:fresh.target},{id:'own',url:'chrome-extension://own/sidepanel.html'},reply=>discarded.push(reply)),false);
    assert.equal(discarded.length,1);assert.equal(discarded[0].status,'discarded');
  }
});
