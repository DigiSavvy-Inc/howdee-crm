// Site tracking snippet (#152), served by /t.js?k=<site_key> with the site key and the
// app's origin inlined. Plain ES5, no dependencies, no eval. The flow (see #151):
//
//   1. `?dsv=<link token>` in the landing URL → POST /api/track/identify → the signed
//      visitor id goes into the SITE's localStorage (`dsv_id`); `dsv` is then removed from
//      the address bar with history.replaceState (other params kept).
//   2. A pageview on load and on SPA navigations (pushState/popstate, debounced), sent with
//      navigator.sendBeacon (text/plain, no preflight), falling back to fetch keepalive.
//   3. Nothing is sent when the browser says DNT/GPC, `localStorage.dsv_optout` is set,
//      or the site set `window.dsvConsent = false` (undefined = allowed).
//
// Public API: window.dsv = { track(name, props), identify(tokenOrId), optOut(), optIn(),
// ready(fn), push(call) }. Calls made before load are queued with the usual pattern:
//   window.dsv = window.dsv || []; dsv.push(['track', 'signup', { plan: 'pro' }]);

const SOURCE = `(function(w,d){
var E=__ENDPOINT__,K=__SITE_KEY__,n=w.navigator,h=w.history,ID='dsv_id',OPT='dsv_optout';
var q=w.dsv;if(q&&q._dsv)return;
var waiting=[],ok=false,last=null,prev=null,timer;
function get(k){try{return w.localStorage.getItem(k)}catch(e){return null}}
function set(k,v){try{v==null?w.localStorage.removeItem(k):w.localStorage.setItem(k,v)}catch(e){}}
function blocked(){return n.doNotTrack==='1'||w.doNotTrack==='1'||n.globalPrivacyControl===true||get(OPT)==='1'||w.dsvConsent===false}
function post(path,body){return fetch(E+path,{method:'POST',mode:'cors',credentials:'omit',keepalive:true,headers:{'content-type':'text/plain'},body:JSON.stringify(body)})}
function utm(){var o={},m,re=/[?&]utm_(source|medium|campaign|content|term)=([^&#]*)/g;while((m=re.exec(location.search))){try{o[m[1]]=decodeURIComponent(m[2].replace(/\\+/g,' '))}catch(e){}}return o}
function send(b){if(blocked())return;var id=get(ID);if(!id)return;b.site_key=K;b.id=id;b.ts=Date.now();var s=JSON.stringify(b);try{if(n.sendBeacon&&n.sendBeacon(E+'/api/track',s))return}catch(e){}try{post('/api/track',b)['catch'](function(){})}catch(e){}}
function pageview(){var p=location.pathname;if(p===last)return;var r=last===null?d.referrer:prev;last=p;prev=location.href;send({kind:'pageview',path:p,title:d.title,referrer:r,utm:utm()})}
function soon(){clearTimeout(timer);timer=setTimeout(pageview,300)}
function whenReady(f){ok?f():waiting.push(f)}
function start(){ok=true;pageview();while(waiting.length){try{waiting.shift()()}catch(e){}}}
function identify(t,done){done=done||function(){};if(!t||blocked())return done();t=String(t);
if(t.split('.').length===4){set(ID,t);return done()}
try{post('/api/track/identify',{site_key:K,token:t}).then(function(r){return r.status===200?r.json():null}).then(function(j){if(j&&j.id)set(ID,j.id)})['catch'](function(){}).then(done)}catch(e){done()}}
var api={_dsv:1,
track:function(name,props){if(!name)return;whenReady(function(){send({kind:'event',name:String(name),path:location.pathname,title:d.title,props:props&&typeof props==='object'?props:undefined})})},
identify:function(t){identify(t)},
optOut:function(){set(OPT,'1');set(ID,null)},
optIn:function(){set(OPT,null)},
ready:function(f){if(typeof f==='function')whenReady(f)},
push:function(c){if(typeof c==='function')return api.ready(c);if(c&&c.length&&c[0]!=='push'&&typeof api[c[0]]==='function')api[c[0]].apply(api,[].slice.call(c,1))}};
w.dsv=api;
if(q&&q.length)for(var i=0;i<q.length;i++){try{api.push(q[i])}catch(e){}}
var m=/[?&]dsv=([^&#]*)/.exec(location.search),tok=null;
if(m){try{tok=decodeURIComponent(m[1])}catch(e){}
try{var u=new URL(location.href);u.searchParams['delete']('dsv');h.replaceState(h.state,'',u.pathname+u.search+u.hash)}catch(e){}}
if(h.pushState){var push=h.pushState;h.pushState=function(){var r=push.apply(this,arguments);soon();return r}}
w.addEventListener('popstate',soon);
identify(tok,start);
})(window,document);
`;

/** Inline a JS string literal; `<` escaped so the value can never close a script tag. */
function jsString(v: string): string {
	return JSON.stringify(v).replace(/</g, '\\u003c');
}

/** The snippet for one site: `endpoint` is the app origin (no trailing slash). */
export function renderTrackingSnippet(opts: { siteKey: string; endpoint: string }): string {
	return SOURCE.replace('__ENDPOINT__', jsString(opts.endpoint.replace(/\/+$/, ''))).replace(
		'__SITE_KEY__',
		jsString(opts.siteKey)
	);
}

/** Served instead of the snippet for a disabled site: valid JS that does nothing. */
export const DISABLED_SNIPPET = '/* tracking disabled */\n';

/** The paste-ready tag for a site's <head>. */
export function installTag(baseUrl: string, siteKey: string): string {
	return `<script async src="${baseUrl.replace(/\/+$/, '')}/t.js?k=${encodeURIComponent(siteKey)}"></script>`;
}

/** Optional consent flag a site sets before the tag (undefined = allowed). */
export const CONSENT_SNIPPET = `<script>
  // Set to false until the visitor agrees; flip to true from your consent banner.
  window.dsvConsent = false;
</script>`;

/** Opt-out link for the site's privacy page. */
export const OPTOUT_SNIPPET = `<a href="#" onclick="dsv.optOut(); return false;">Opt out of site tracking</a>`;
