const fs=require('fs'), path=require('path'), {JSDOM}=require('jsdom');
const siteDir=path.resolve('/home/user/netlifyf1');
const html=fs.readFileSync(path.join(siteDir,'index.html'),'utf8');
const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,url:'https://freef1.netlify.app/'});
const w=dom.window;
w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
w.requestIdleCallback=cb=>setTimeout(()=>cb({timeRemaining:()=>50}),0);
w.scrollTo=()=>{};
w.IntersectionObserver=class{observe(){} unobserve(){} disconnect(){}};
w.EventSource=class{addEventListener(){} close(){}};
w.fetch=async (url, opts)=>({ok:true,status:200,json:async()=>({}),text:async()=>('{}'),type:'basic'});
w.eval(fs.readFileSync(path.join(siteDir,'app.js'),'utf8'));
setTimeout(()=>{
  try{
    const hero = w.document.querySelector('#heroLayer picture source');
    const img = w.document.querySelector('#heroLayer picture img');
    console.log("source srcset:", hero ? hero.getAttribute('srcset').slice(0,120) : 'no source');
    console.log("img src:", img ? img.getAttribute('src').slice(0,120) : 'no img');
    console.log("heroLayer exists:", !!w.document.getElementById('heroLayer'));
    console.log("heroLayer innerHTML:", w.document.getElementById('heroLayer').innerHTML.slice(0,300));
    // Check computed style if any
    const heroEl = w.document.querySelector('.hero');
    console.log("hero class:", heroEl ? heroEl.className : 'no hero');
    // Check if app.js hides hero
    console.log("app.js heroTitle:", w.document.getElementById('heroTitle')?.textContent);
  }catch(e){ console.error(e.stack)}
},800);
