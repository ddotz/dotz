var Qp=Object.create;var{getPrototypeOf:Zp,defineProperty:Ii,getOwnPropertyNames:Yp}=Object;var Ci=Object.prototype.hasOwnProperty;function Jp(e){return this[e]}var em,am,ki=(e,a,t)=>{var n=e!=null&&typeof e==="object";if(n){var r=a?em??=new WeakMap:am??=new WeakMap,o=r.get(e);if(o)return o}t=e!=null?Qp(Zp(e)):{};let s=a||!e||!e.__esModule||!Ci.call(e,"default")?Ii(t,"default",{value:e,enumerable:!0}):t;if(e&&typeof e==="object"||typeof e==="function"){for(let l of Yp(e))if(!Ci.call(s,l))Ii(s,l,{get:Jp.bind(e,l),enumerable:!0})}if(n)r.set(e,s);return s};var Si=(e,a)=>()=>(a||e((a={exports:{}}).exports,a),a.exports);var Gs=(e,a,t)=>()=>{if(e)try{a=e(e=0)}catch(n){t=[n]}if(t)throw t[0];return a};function bn(e,a,t){this.props=e,this.context=a,this.refs=bi,this.updater=t||Pi}function Mi(){}function Ai(e,a,t){this.props=e,this.context=a,this.refs=bi,this.updater=t||Pi}function im(e,a,t){var n,r={},o=null,s=null;if(a!=null)for(n in a.ref!==void 0&&(s=a.ref),a.key!==void 0&&(o=""+a.key),a)lm.call(a,n)&&!um.hasOwnProperty(n)&&(r[n]=a[n]);var l=arguments.length-2;if(l===1)r.children=t;else if(1<l){for(var u=Array(l),c=0;c<l;c++)u[c]=arguments[c+2];r.children=u}if(e&&e.defaultProps)for(n in l=e.defaultProps,l)r[n]===void 0&&(r[n]=l[n]);return{$$typeof:tm,type:e,key:o,ref:s,props:r,_owner:Ti.current}}var tm,nm,rm,om,Pi,sm,bi,js,lm,Ti,um,Ha,dm,fm,Mn,An=function(e){return e={$$typeof:rm,_currentValue:e,_currentValue2:e,_threadCount:0,Provider:null,Consumer:null,_defaultValue:null,_globalName:null},e.Provider={$$typeof:nm,_context:e},e.Consumer=e},Vt,Tn=function(e){return{$$typeof:om,render:e}},Ta=function(e,a){return Ha.current.useCallback(e,a)},_n=function(e){return Ha.current.useContext(e)},qa=function(e,a){return Ha.current.useEffect(e,a)},sa=function(e,a){return Ha.current.useLayoutEffect(e,a)},so=function(e,a){return Ha.current.useMemo(e,a)},J=function(e){return Ha.current.useRef(e)},ge=function(e){return Ha.current.useState(e)};var va=Gs(()=>{tm=Symbol.for("react.element"),nm=Symbol.for("react.provider"),rm=Symbol.for("react.context"),om=Symbol.for("react.forward_ref"),Pi={isMounted:function(){return!1},enqueueForceUpdate:function(){},enqueueReplaceState:function(){},enqueueSetState:function(){}},sm=Object.assign,bi={};bn.prototype.isReactComponent={};bn.prototype.setState=function(e,a){if(typeof e!=="object"&&typeof e!=="function"&&e!=null)throw Error("setState(...): takes an object of state variables to update or a function which returns an object of state variables.");this.updater.enqueueSetState(this,e,a,"setState")};bn.prototype.forceUpdate=function(e){this.updater.enqueueForceUpdate(this,e,"forceUpdate")};Mi.prototype=bn.prototype;js=Ai.prototype=new Mi;js.constructor=Ai;sm(js,bn.prototype);js.isPureReactComponent=!0;lm=Object.prototype.hasOwnProperty,Ti={current:null},um={key:!0,ref:!0,__self:!0,__source:!0};Ha={current:null},dm={transition:null},fm={ReactCurrentDispatcher:Ha,ReactCurrentBatchConfig:dm,ReactCurrentOwner:Ti};Mn=fm,Vt=im});var Ni=Si(function(jt){function Xs(e,a){var t=e.length;e.push(a);e:for(;0<t;){var n=t-1>>>1,r=e[n];if(0<lo(r,a))e[n]=a,e[t]=r,t=n;else break e}}function la(e){return e.length===0?null:e[0]}function co(e){if(e.length===0)return null;var a=e[0],t=e.pop();if(t!==a){e[0]=t;e:for(var n=0,r=e.length,o=r>>>1;n<o;){var s=2*(n+1)-1,l=e[s],u=s+1,c=e[u];if(0>lo(l,t))u<r&&0>lo(c,l)?(e[n]=c,e[u]=t,n=u):(e[n]=l,e[s]=t,n=s);else if(u<r&&0>lo(c,t))e[n]=c,e[u]=t,n=u;else break e}}return a}function lo(e,a){var t=e.sortIndex-a.sortIndex;return t!==0?t:e.id-a.id}if(typeof performance==="object"&&typeof performance.now==="function")$s=performance,jt.unstable_now=function(){return $s.now()};else uo=Date,Qs=uo.now(),jt.unstable_now=function(){return uo.now()-Qs};var $s,uo,Qs,Ia=[],Wa=[],cm=1,Qe=null,Me=3,po=!1,yt=!1,Rn=!1,Ri=typeof setTimeout==="function"?setTimeout:null,Fi=typeof clearTimeout==="function"?clearTimeout:null,zi=typeof setImmediate<"u"?setImmediate:null;typeof navigator<"u"&&navigator.scheduling!==void 0&&navigator.scheduling.isInputPending!==void 0&&navigator.scheduling.isInputPending.bind(navigator.scheduling);function Zs(e){for(var a=la(Wa);a!==null;){if(a.callback===null)co(Wa);else if(a.startTime<=e)co(Wa),a.sortIndex=a.expirationTime,Xs(Ia,a);else break;a=la(Wa)}}function Js(e){if(Rn=!1,Zs(e),!yt)if(la(Ia)!==null)yt=!0,al(el);else{var a=la(Wa);a!==null&&tl(Js,a.startTime-e)}}function el(e,a){yt=!1,Rn&&(Rn=!1,Fi(Fn),Fn=-1),po=!0;var t=Me;try{Zs(a);for(Qe=la(Ia);Qe!==null&&(!(Qe.expirationTime>a)||e&&!Ei());){var n=Qe.callback;if(typeof n==="function"){Qe.callback=null,Me=Qe.priorityLevel;var r=n(Qe.expirationTime<=a);a=jt.unstable_now(),typeof r==="function"?Qe.callback=r:Qe===la(Ia)&&co(Ia),Zs(a)}else co(Ia);Qe=la(Ia)}if(Qe!==null)var o=!0;else{var s=la(Wa);s!==null&&tl(Js,s.startTime-a),o=!1}return o}finally{Qe=null,Me=t,po=!1}}var mo=!1,io=null,Fn=-1,Di=5,Bi=-1;function Ei(){return jt.unstable_now()-Bi<Di?!1:!0}function Ks(){if(io!==null){var e=jt.unstable_now();Bi=e;var a=!0;try{a=io(!0,e)}finally{a?zn():(mo=!1,io=null)}}else mo=!1}var zn;if(typeof zi==="function")zn=function(){zi(Ks)};else if(typeof MessageChannel<"u")fo=new MessageChannel,Ys=fo.port2,fo.port1.onmessage=Ks,zn=function(){Ys.postMessage(null)};else zn=function(){Ri(Ks,0)};var fo,Ys;function al(e){io=e,mo||(mo=!0,zn())}function tl(e,a){Fn=Ri(function(){e(jt.unstable_now())},a)}jt.unstable_IdlePriority=5;jt.unstable_ImmediatePriority=1;jt.unstable_LowPriority=4;jt.unstable_NormalPriority=3;jt.unstable_Profiling=null;jt.unstable_UserBlockingPriority=2;jt.unstable_cancelCallback=function(e){e.callback=null};jt.unstable_continueExecution=function(){yt||po||(yt=!0,al(el))};jt.unstable_forceFrameRate=function(e){0>e||125<e?console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"):Di=0<e?Math.floor(1000/e):5};jt.unstable_getCurrentPriorityLevel=function(){return Me};jt.unstable_getFirstCallbackNode=function(){return la(Ia)};jt.unstable_next=function(e){switch(Me){case 1:case 2:case 3:var a=3;break;default:a=Me}var t=Me;Me=a;try{return e()}finally{Me=t}};jt.unstable_pauseExecution=function(){};jt.unstable_requestPaint=function(){};jt.unstable_runWithPriority=function(e,a){switch(e){case 1:case 2:case 3:case 4:case 5:break;default:e=3}var t=Me;Me=e;try{return a()}finally{Me=t}};jt.unstable_scheduleCallback=function(e,a,t){var n=jt.unstable_now();switch(typeof t==="object"&&t!==null?(t=t.delay,t=typeof t==="number"&&0<t?n+t:n):t=n,e){case 1:var r=-1;break;case 2:r=250;break;case 5:r=1073741823;break;case 4:r=1e4;break;default:r=5000}return r=t+r,e={id:cm++,callback:a,priorityLevel:e,startTime:t,expirationTime:r,sortIndex:-1},t>n?(e.sortIndex=t,Xs(Wa,e),la(Ia)===null&&e===la(Wa)&&(Rn?(Fi(Fn),Fn=-1):Rn=!0,tl(Js,t-n))):(e.sortIndex=r,Xs(Ia,e),yt||po||(yt=!0,al(el))),e};jt.unstable_shouldYield=Ei;jt.unstable_wrapCallback=function(e){var a=Me;return function(){var t=Me;Me=a;try{return e.apply(this,arguments)}finally{Me=t}}}});function C(e){for(var a="https://reactjs.org/docs/error-decoder.html?invariant="+e,t=1;t<arguments.length;t++)a+="&args[]="+encodeURIComponent(arguments[t]);return"Minified React error #"+e+"; visit "+a+" for the full message or use the non-minified dev environment for full errors and additional helpful warnings."}function Rt(e,a){cn(e,a),cn(e+"Capture",a)}function cn(e,a){lr[e]=a;for(e=0;e<a.length;e++)qd.add(a[e])}function zm(e){if(kl.call(Ui,e))return!0;if(kl.call(Oi,e))return!1;if(_m.test(e))return Ui[e]=!0;return Oi[e]=!0,!1}function Rm(e,a,t,n){if(t!==null&&t.type===0)return!1;switch(typeof a){case"function":case"symbol":return!0;case"boolean":if(n)return!1;if(t!==null)return!t.acceptsBooleans;return e=e.toLowerCase().slice(0,5),e!=="data-"&&e!=="aria-";default:return!1}}function Fm(e,a,t,n){if(a===null||typeof a>"u"||Rm(e,a,t,n))return!0;if(n)return!1;if(t!==null)switch(t.type){case 3:return!a;case 4:return a===!1;case 5:return isNaN(a);case 6:return isNaN(a)||1>a}return!1}function Be(e,a,t,n,r,o,s){this.acceptsBooleans=a===2||a===3||a===4,this.attributeName=n,this.attributeNamespace=r,this.mustUseProperty=t,this.propertyName=e,this.type=a,this.sanitizeURL=o,this.removeEmptyString=s}function wu(e){return e[1].toUpperCase()}function yu(e,a,t,n){var r=be.hasOwnProperty(a)?be[a]:null;if(r!==null?r.type!==0:n||!(2<a.length)||a[0]!=="o"&&a[0]!=="O"||a[1]!=="n"&&a[1]!=="N")Fm(a,t,r,n)&&(t=null),n||r===null?zm(a)&&(t===null?e.removeAttribute(a):e.setAttribute(a,""+t)):r.mustUseProperty?e[r.propertyName]=t===null?r.type===3?!1:"":t:(a=r.attributeName,n=r.attributeNamespace,t===null?e.removeAttribute(a):(r=r.type,t=r===3||r===4&&t===!0?"":""+t,n?e.setAttributeNS(n,a,t):e.setAttribute(a,t)))}function Dn(e){if(e===null||typeof e!=="object")return null;return e=Hi&&e[Hi]||e["@@iterator"],typeof e==="function"?e:null}function Wn(e){if(nl===void 0)try{throw Error()}catch(t){var a=t.stack.trim().match(/\n( *(at )?)/);nl=a&&a[1]||""}return`
`+nl+e}function ol(e,a){if(!e||rl)return"";rl=!0;var t=Error.prepareStackTrace;Error.prepareStackTrace=void 0;try{if(a)if(a=function(){throw Error()},Object.defineProperty(a.prototype,"props",{set:function(){throw Error()}}),typeof Reflect==="object"&&Reflect.construct){try{Reflect.construct(a,[])}catch(c){var n=c}Reflect.construct(e,[],a)}else{try{a.call()}catch(c){n=c}e.call(a.prototype)}else{try{throw Error()}catch(c){n=c}e()}}catch(c){if(c&&n&&typeof c.stack==="string"){for(var r=c.stack.split(`
`),o=n.stack.split(`
`),s=r.length-1,l=o.length-1;1<=s&&0<=l&&r[s]!==o[l];)l--;for(;1<=s&&0<=l;s--,l--)if(r[s]!==o[l]){if(s!==1||l!==1)do if(s--,l--,0>l||r[s]!==o[l]){var u=`
`+r[s].replace(" at new "," at ");return e.displayName&&u.includes("<anonymous>")&&(u=u.replace("<anonymous>",e.displayName)),u}while(1<=s&&0<=l);break}}}finally{rl=!1,Error.prepareStackTrace=t}return(e=e?e.displayName||e.name:"")?Wn(e):""}function Dm(e){switch(e.tag){case 5:return Wn(e.type);case 16:return Wn("Lazy");case 13:return Wn("Suspense");case 19:return Wn("SuspenseList");case 0:case 2:case 15:return e=ol(e.type,!1),e;case 11:return e=ol(e.type.render,!1),e;case 1:return e=ol(e.type,!0),e;default:return""}}function Ml(e){if(e==null)return null;if(typeof e==="function")return e.displayName||e.name||null;if(typeof e==="string")return e;switch(e){case $t:return"Fragment";case qn:return"Portal";case Sl:return"Profiler";case vu:return"StrictMode";case Pl:return"Suspense";case bl:return"SuspenseList"}if(typeof e==="object")switch(e.$$typeof){case Vd:return(e.displayName||"Context")+".Consumer";case Wd:return(e._context.displayName||"Context")+".Provider";case Iu:var a=e.render;return e=e.displayName,e||(e=a.displayName||a.name||"",e=e!==""?"ForwardRef("+e+")":"ForwardRef"),e;case Cu:return a=e.displayName||null,a!==null?a:Ml(e.type)||"Memo";case Ga:a=e._payload,e=e._init;try{return Ml(e(a))}catch(t){}}return null}function Bm(e){var a=e.type;switch(e.tag){case 24:return"Cache";case 9:return(a.displayName||"Context")+".Consumer";case 10:return(a._context.displayName||"Context")+".Provider";case 18:return"DehydratedFragment";case 11:return e=a.render,e=e.displayName||e.name||"",a.displayName||(e!==""?"ForwardRef("+e+")":"ForwardRef");case 7:return"Fragment";case 5:return a;case 4:return"Portal";case 3:return"Root";case 6:return"Text";case 16:return Ml(a);case 8:return a===vu?"StrictMode":"Mode";case 22:return"Offscreen";case 12:return"Profiler";case 21:return"Scope";case 13:return"Suspense";case 19:return"SuspenseList";case 25:return"TracingMarker";case 1:case 0:case 17:case 2:case 14:case 15:if(typeof a==="function")return a.displayName||a.name||null;if(typeof a==="string")return a}return null}function ot(e){switch(typeof e){case"boolean":case"number":case"string":case"undefined":return e;case"object":return e;default:return""}}function jd(e){var a=e.type;return(e=e.nodeName)&&e.toLowerCase()==="input"&&(a==="checkbox"||a==="radio")}function Em(e){var a=jd(e)?"checked":"value",t=Object.getOwnPropertyDescriptor(e.constructor.prototype,a),n=""+e[a];if(!e.hasOwnProperty(a)&&typeof t<"u"&&typeof t.get==="function"&&typeof t.set==="function"){var{get:r,set:o}=t;return Object.defineProperty(e,a,{configurable:!0,get:function(){return r.call(this)},set:function(s){n=""+s,o.call(this,s)}}),Object.defineProperty(e,a,{enumerable:t.enumerable}),{getValue:function(){return n},setValue:function(s){n=""+s},stopTracking:function(){e._valueTracker=null,delete e[a]}}}}function go(e){e._valueTracker||(e._valueTracker=Em(e))}function Kd(e){if(!e)return!1;var a=e._valueTracker;if(!a)return!0;var t=a.getValue(),n="";return e&&(n=jd(e)?e.checked?"true":"false":e.value),e=n,e!==t?(a.setValue(e),!0):!1}function Ho(e){if(e=e||(typeof document<"u"?document:void 0),typeof e>"u")return null;try{return e.activeElement||e.body}catch(a){return e.body}}function Al(e,a){var t=a.checked;return le({},a,{defaultChecked:void 0,defaultValue:void 0,value:void 0,checked:t!=null?t:e._wrapperState.initialChecked})}function qi(e,a){var t=a.defaultValue==null?"":a.defaultValue,n=a.checked!=null?a.checked:a.defaultChecked;t=ot(a.value!=null?a.value:t),e._wrapperState={initialChecked:n,initialValue:t,controlled:a.type==="checkbox"||a.type==="radio"?a.checked!=null:a.value!=null}}function Xd(e,a){a=a.checked,a!=null&&yu(e,"checked",a,!1)}function Tl(e,a){Xd(e,a);var t=ot(a.value),n=a.type;if(t!=null)if(n==="number"){if(t===0&&e.value===""||e.value!=t)e.value=""+t}else e.value!==""+t&&(e.value=""+t);else if(n==="submit"||n==="reset"){e.removeAttribute("value");return}a.hasOwnProperty("value")?_l(e,a.type,t):a.hasOwnProperty("defaultValue")&&_l(e,a.type,ot(a.defaultValue)),a.checked==null&&a.defaultChecked!=null&&(e.defaultChecked=!!a.defaultChecked)}function Wi(e,a,t){if(a.hasOwnProperty("value")||a.hasOwnProperty("defaultValue")){var n=a.type;if(!(n!=="submit"&&n!=="reset"||a.value!==void 0&&a.value!==null))return;a=""+e._wrapperState.initialValue,t||a===e.value||(e.value=a),e.defaultValue=a}t=e.name,t!==""&&(e.name=""),e.defaultChecked=!!e._wrapperState.initialChecked,t!==""&&(e.name=t)}function _l(e,a,t){if(a!=="number"||Ho(e.ownerDocument)!==e)t==null?e.defaultValue=""+e._wrapperState.initialValue:e.defaultValue!==""+t&&(e.defaultValue=""+t)}function on(e,a,t,n){if(e=e.options,a){a={};for(var r=0;r<t.length;r++)a["$"+t[r]]=!0;for(t=0;t<e.length;t++)r=a.hasOwnProperty("$"+e[t].value),e[t].selected!==r&&(e[t].selected=r),r&&n&&(e[t].defaultSelected=!0)}else{t=""+ot(t),a=null;for(r=0;r<e.length;r++){if(e[r].value===t){e[r].selected=!0,n&&(e[r].defaultSelected=!0);return}a!==null||e[r].disabled||(a=e[r])}a!==null&&(a.selected=!0)}}function zl(e,a){if(a.dangerouslySetInnerHTML!=null)throw Error(C(91));return le({},a,{value:void 0,defaultValue:void 0,children:""+e._wrapperState.initialValue})}function Vi(e,a){var t=a.value;if(t==null){if(t=a.children,a=a.defaultValue,t!=null){if(a!=null)throw Error(C(92));if(Vn(t)){if(1<t.length)throw Error(C(93));t=t[0]}a=t}a==null&&(a=""),t=a}e._wrapperState={initialValue:ot(t)}}function $d(e,a){var t=ot(a.value),n=ot(a.defaultValue);t!=null&&(t=""+t,t!==e.value&&(e.value=t),a.defaultValue==null&&e.defaultValue!==t&&(e.defaultValue=t)),n!=null&&(e.defaultValue=""+n)}function Gi(e){var a=e.textContent;a===e._wrapperState.initialValue&&a!==""&&a!==null&&(e.value=a)}function Qd(e){switch(e){case"svg":return"http://www.w3.org/2000/svg";case"math":return"http://www.w3.org/1998/Math/MathML";default:return"http://www.w3.org/1999/xhtml"}}function Rl(e,a){return e==null||e==="http://www.w3.org/1999/xhtml"?Qd(a):e==="http://www.w3.org/2000/svg"&&a==="foreignObject"?"http://www.w3.org/1999/xhtml":e}function ur(e,a){if(a){var t=e.firstChild;if(t&&t===e.lastChild&&t.nodeType===3){t.nodeValue=a;return}}e.textContent=a}function Yd(e,a,t){return a==null||typeof a==="boolean"||a===""?"":t||typeof a!=="number"||a===0||Yn.hasOwnProperty(e)&&Yn[e]?(""+a).trim():a+"px"}function Jd(e,a){e=e.style;for(var t in a)if(a.hasOwnProperty(t)){var n=t.indexOf("--")===0,r=Yd(t,a[t],n);t==="float"&&(t="cssFloat"),n?e.setProperty(t,r):e[t]=r}}function Fl(e,a){if(a){if(Om[e]&&(a.children!=null||a.dangerouslySetInnerHTML!=null))throw Error(C(137,e));if(a.dangerouslySetInnerHTML!=null){if(a.children!=null)throw Error(C(60));if(typeof a.dangerouslySetInnerHTML!=="object"||!("__html"in a.dangerouslySetInnerHTML))throw Error(C(61))}if(a.style!=null&&typeof a.style!=="object")throw Error(C(62))}}function Dl(e,a){if(e.indexOf("-")===-1)return typeof a.is==="string";switch(e){case"annotation-xml":case"color-profile":case"font-face":case"font-face-src":case"font-face-uri":case"font-face-format":case"font-face-name":case"missing-glyph":return!1;default:return!0}}function ku(e){return e=e.target||e.srcElement||window,e.correspondingUseElement&&(e=e.correspondingUseElement),e.nodeType===3?e.parentNode:e}function ji(e){if(e=ms(e)){if(typeof El!=="function")throw Error(C(280));var a=e.stateNode;a&&(a=Du(a),El(e.stateNode,e.type,a))}}function Um(e){sn?ln?ln.push(e):ln=[e]:sn=e}function Hm(){if(sn){var e=sn,a=ln;if(ln=sn=null,ji(e),a)for(e=0;e<a.length;e++)ji(a[e])}}function ef(e,a){return e(a)}function af(){}function tf(e,a,t){if(sl)return e(a,t);sl=!0;try{return ef(e,a,t)}finally{if(sl=!1,sn!==null||ln!==null)af(),Hm()}}function ir(e,a){var t=e.stateNode;if(t===null)return null;var n=Du(t);if(n===null)return null;t=n[a];e:switch(a){case"onClick":case"onClickCapture":case"onDoubleClick":case"onDoubleClickCapture":case"onMouseDown":case"onMouseDownCapture":case"onMouseMove":case"onMouseMoveCapture":case"onMouseUp":case"onMouseUpCapture":case"onMouseEnter":(n=!n.disabled)||(e=e.type,n=!(e==="button"||e==="input"||e==="select"||e==="textarea")),e=!n;break e;default:e=!1}if(e)return null;if(t&&typeof t!=="function")throw Error(C(231,a,typeof t));return t}function qm(e,a,t,n,r,o,s,l,u){var c=Array.prototype.slice.call(arguments,3);try{a.apply(t,c)}catch(m){this.onError(m)}}function Vm(e,a,t,n,r,o,s,l,u){Jn=!1,qo=null,qm.apply(Wm,arguments)}function Gm(e,a,t,n,r,o,s,l,u){if(Vm.apply(this,arguments),Jn){if(Jn){var c=qo;Jn=!1,qo=null}else throw Error(C(198));Wo||(Wo=!0,Ol=c)}}function Ft(e){var a=e,t=e;if(e.alternate)for(;a.return;)a=a.return;else{e=a;do a=e,(a.flags&4098)!==0&&(t=a.return),e=a.return;while(e)}return a.tag===3?t:null}function nf(e){if(e.tag===13){var a=e.memoizedState;if(a===null&&(e=e.alternate,e!==null&&(a=e.memoizedState)),a!==null)return a.dehydrated}return null}function Ki(e){if(Ft(e)!==e)throw Error(C(188))}function jm(e){var a=e.alternate;if(!a){if(a=Ft(e),a===null)throw Error(C(188));return a!==e?null:e}for(var t=e,n=a;;){var r=t.return;if(r===null)break;var o=r.alternate;if(o===null){if(n=r.return,n!==null){t=n;continue}break}if(r.child===o.child){for(o=r.child;o;){if(o===t)return Ki(r),e;if(o===n)return Ki(r),a;o=o.sibling}throw Error(C(188))}if(t.return!==n.return)t=r,n=o;else{for(var s=!1,l=r.child;l;){if(l===t){s=!0,t=r,n=o;break}if(l===n){s=!0,n=r,t=o;break}l=l.sibling}if(!s){for(l=o.child;l;){if(l===t){s=!0,t=o,n=r;break}if(l===n){s=!0,n=o,t=r;break}l=l.sibling}if(!s)throw Error(C(189))}}if(t.alternate!==n)throw Error(C(190))}if(t.tag!==3)throw Error(C(188));return t.stateNode.current===t?e:a}function Km(e){return e=jm(e),e!==null?rf(e):null}function rf(e){if(e.tag===5||e.tag===6)return e;for(e=e.child;e!==null;){var a=rf(e);if(a!==null)return a;e=e.sibling}return null}function Ym(e){if(Pa&&typeof Pa.onCommitFiberRoot==="function")try{Pa.onCommitFiberRoot(ds,e,void 0,(e.current.flags&128)===128)}catch(a){}}function a0(e){return e>>>=0,e===0?32:31-(Jm(e)/e0|0)|0}function Gn(e){switch(e&-e){case 1:return 1;case 2:return 2;case 4:return 4;case 8:return 8;case 16:return 16;case 32:return 32;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return e&4194240;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return e&130023424;case 134217728:return 134217728;case 268435456:return 268435456;case 536870912:return 536870912;case 1073741824:return 1073741824;default:return e}}function Go(e,a){var t=e.pendingLanes;if(t===0)return 0;var n=0,r=e.suspendedLanes,o=e.pingedLanes,s=t&268435455;if(s!==0){var l=s&~r;l!==0?n=Gn(l):(o&=s,o!==0&&(n=Gn(o)))}else s=t&~r,s!==0?n=Gn(s):o!==0&&(n=Gn(o));if(n===0)return 0;if(a!==0&&a!==n&&(a&r)===0&&(r=n&-n,o=a&-a,r>=o||r===16&&(o&4194240)!==0))return a;if((n&4)!==0&&(n|=t&16),a=e.entangledLanes,a!==0)for(e=e.entanglements,a&=n;0<a;)t=31-ca(a),r=1<<t,n|=e[t],a&=~r;return n}function t0(e,a){switch(e){case 1:case 2:case 4:return a+250;case 8:case 16:case 32:case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return a+5000;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return-1;case 134217728:case 268435456:case 536870912:case 1073741824:return-1;default:return-1}}function n0(e,a){for(var{suspendedLanes:t,pingedLanes:n,expirationTimes:r,pendingLanes:o}=e;0<o;){var s=31-ca(o),l=1<<s,u=r[s];if(u===-1){if((l&t)===0||(l&n)!==0)r[s]=t0(l,a)}else u<=a&&(e.expiredLanes|=l);o&=~l}}function Ul(e){return e=e.pendingLanes&-1073741825,e!==0?e:e&1073741824?1073741824:0}function uf(){var e=Lo;return Lo<<=1,(Lo&4194240)===0&&(Lo=64),e}function ll(e){for(var a=[],t=0;31>t;t++)a.push(e);return a}function Cr(e,a,t){e.pendingLanes|=a,a!==536870912&&(e.suspendedLanes=0,e.pingedLanes=0),e=e.eventTimes,a=31-ca(a),e[a]=t}function r0(e,a){var t=e.pendingLanes&~a;e.pendingLanes=a,e.suspendedLanes=0,e.pingedLanes=0,e.expiredLanes&=a,e.mutableReadLanes&=a,e.entangledLanes&=a,a=e.entanglements;var n=e.eventTimes;for(e=e.expirationTimes;0<t;){var r=31-ca(t),o=1<<r;a[r]=0,n[r]=-1,e[r]=-1,t&=~o}}function Pu(e,a){var t=e.entangledLanes|=a;for(e=e.entanglements;t;){var n=31-ca(t),r=1<<n;r&a|e[n]&a&&(e[n]|=a),t&=~r}}function df(e){return e&=-e,1<e?4<e?(e&268435455)!==0?16:536870912:4:1}function $i(e,a){switch(e){case"focusin":case"focusout":Za=null;break;case"dragenter":case"dragleave":Ya=null;break;case"mouseover":case"mouseout":Ja=null;break;case"pointerover":case"pointerout":dr.delete(a.pointerId);break;case"gotpointercapture":case"lostpointercapture":fr.delete(a.pointerId)}}function Bn(e,a,t,n,r,o){if(e===null||e.nativeEvent!==o)return e={blockedOn:a,domEventName:t,eventSystemFlags:n,nativeEvent:o,targetContainers:[r]},a!==null&&(a=ms(a),a!==null&&bu(a)),e;return e.eventSystemFlags|=n,a=e.targetContainers,r!==null&&a.indexOf(r)===-1&&a.push(r),e}function s0(e,a,t,n,r){switch(a){case"focusin":return Za=Bn(Za,e,a,t,n,r),!0;case"dragenter":return Ya=Bn(Ya,e,a,t,n,r),!0;case"mouseover":return Ja=Bn(Ja,e,a,t,n,r),!0;case"pointerover":var o=r.pointerId;return dr.set(o,Bn(dr.get(o)||null,e,a,t,n,r)),!0;case"gotpointercapture":return o=r.pointerId,fr.set(o,Bn(fr.get(o)||null,e,a,t,n,r)),!0}return!1}function hf(e){var a=kt(e.target);if(a!==null){var t=Ft(a);if(t!==null){if(a=t.tag,a===13){if(a=nf(t),a!==null){e.blockedOn=a,mf(e.priority,function(){cf(t)});return}}else if(a===3&&t.stateNode.current.memoizedState.isDehydrated){e.blockedOn=t.tag===3?t.stateNode.containerInfo:null;return}}}e.blockedOn=null}function To(e){if(e.blockedOn!==null)return!1;for(var a=e.targetContainers;0<a.length;){var t=ql(e.domEventName,e.eventSystemFlags,a[0],e.nativeEvent);if(t===null){t=e.nativeEvent;var n=new t.constructor(t.type,t);Bl=n,t.target.dispatchEvent(n),Bl=null}else return a=ms(t),a!==null&&bu(a),e.blockedOn=t,!1;a.shift()}return!0}function Qi(e,a,t){To(e)&&t.delete(a)}function l0(){Hl=!1,Za!==null&&To(Za)&&(Za=null),Ya!==null&&To(Ya)&&(Ya=null),Ja!==null&&To(Ja)&&(Ja=null),dr.forEach(Qi),fr.forEach(Qi)}function En(e,a){e.blockedOn===a&&(e.blockedOn=null,Hl||(Hl=!0,ne.unstable_scheduleCallback(ne.unstable_NormalPriority,l0)))}function cr(e){function a(r){return En(r,e)}if(0<yo.length){En(yo[0],e);for(var t=1;t<yo.length;t++){var n=yo[t];n.blockedOn===e&&(n.blockedOn=null)}}Za!==null&&En(Za,e),Ya!==null&&En(Ya,e),Ja!==null&&En(Ja,e),dr.forEach(a),fr.forEach(a);for(t=0;t<Ka.length;t++)n=Ka[t],n.blockedOn===e&&(n.blockedOn=null);for(;0<Ka.length&&(t=Ka[0],t.blockedOn===null);)hf(t),t.blockedOn===null&&Ka.shift()}function u0(e,a,t,n){var r=j,o=un.transition;un.transition=null;try{j=1,Mu(e,a,t,n)}finally{j=r,un.transition=o}}function i0(e,a,t,n){var r=j,o=un.transition;un.transition=null;try{j=4,Mu(e,a,t,n)}finally{j=r,un.transition=o}}function Mu(e,a,t,n){if(jo){var r=ql(e,a,t,n);if(r===null)pl(e,a,n,Ko,t),$i(e,n);else if(s0(r,e,a,t,n))n.stopPropagation();else if($i(e,n),a&4&&-1<o0.indexOf(e)){for(;r!==null;){var o=ms(r);if(o!==null&&ff(o),o=ql(e,a,t,n),o===null&&pl(e,a,n,Ko,t),o===r)break;r=o}r!==null&&n.stopPropagation()}else pl(e,a,n,null,t)}}function ql(e,a,t,n){if(Ko=null,e=ku(n),e=kt(e),e!==null)if(a=Ft(e),a===null)e=null;else if(t=a.tag,t===13){if(e=nf(a),e!==null)return e;e=null}else if(t===3){if(a.stateNode.current.memoizedState.isDehydrated)return a.tag===3?a.stateNode.containerInfo:null;e=null}else a!==e&&(e=null);return Ko=e,null}function gf(e){switch(e){case"cancel":case"click":case"close":case"contextmenu":case"copy":case"cut":case"auxclick":case"dblclick":case"dragend":case"dragstart":case"drop":case"focusin":case"focusout":case"input":case"invalid":case"keydown":case"keypress":case"keyup":case"mousedown":case"mouseup":case"paste":case"pause":case"play":case"pointercancel":case"pointerdown":case"pointerup":case"ratechange":case"reset":case"resize":case"seeked":case"submit":case"touchcancel":case"touchend":case"touchstart":case"volumechange":case"change":case"selectionchange":case"textInput":case"compositionstart":case"compositionend":case"compositionupdate":case"beforeblur":case"afterblur":case"beforeinput":case"blur":case"fullscreenchange":case"focus":case"hashchange":case"popstate":case"select":case"selectstart":return 1;case"drag":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"mousemove":case"mouseout":case"mouseover":case"pointermove":case"pointerout":case"pointerover":case"scroll":case"toggle":case"touchmove":case"wheel":case"mouseenter":case"mouseleave":case"pointerenter":case"pointerleave":return 4;case"message":switch(Qm()){case Su:return 1;case sf:return 4;case Vo:case Zm:return 16;case lf:return 536870912;default:return 16}default:return 16}}function xf(){if(_o)return _o;var e,a=Au,t=a.length,n,r="value"in $a?$a.value:$a.textContent,o=r.length;for(e=0;e<t&&a[e]===r[e];e++);var s=t-e;for(n=1;n<=s&&a[t-n]===r[o-n];n++);return _o=r.slice(e,1<n?1-n:void 0)}function zo(e){var a=e.keyCode;return"charCode"in e?(e=e.charCode,e===0&&a===13&&(e=13)):e=a,e===10&&(e=13),32<=e||e===13?e:0}function vo(){return!0}function Zi(){return!1}function je(e){function a(t,n,r,o,s){this._reactName=t,this._targetInst=r,this.type=n,this.nativeEvent=o,this.target=s,this.currentTarget=null;for(var l in e)e.hasOwnProperty(l)&&(t=e[l],this[l]=t?t(o):o[l]);return this.isDefaultPrevented=(o.defaultPrevented!=null?o.defaultPrevented:o.returnValue===!1)?vo:Zi,this.isPropagationStopped=Zi,this}return le(a.prototype,{preventDefault:function(){this.defaultPrevented=!0;var t=this.nativeEvent;t&&(t.preventDefault?t.preventDefault():typeof t.returnValue!=="unknown"&&(t.returnValue=!1),this.isDefaultPrevented=vo)},stopPropagation:function(){var t=this.nativeEvent;t&&(t.stopPropagation?t.stopPropagation():typeof t.cancelBubble!=="unknown"&&(t.cancelBubble=!0),this.isPropagationStopped=vo)},persist:function(){},isPersistent:vo}),a}function I0(e){var a=this.nativeEvent;return a.getModifierState?a.getModifierState(e):(e=v0[e])?!!a[e]:!1}function _u(){return I0}function wf(e,a){switch(e){case"keyup":return z0.indexOf(a.keyCode)!==-1;case"keydown":return a.keyCode!==229;case"keypress":case"mousedown":case"focusout":return!0;default:return!1}}function yf(e){return e=e.detail,typeof e==="object"&&"data"in e?e.data:null}function F0(e,a){switch(e){case"compositionend":return yf(a);case"keypress":if(a.which!==32)return null;return td=!0,ad;case"textInput":return e=a.data,e===ad&&td?null:e;default:return null}}function D0(e,a){if(Qt)return e==="compositionend"||!zu&&wf(e,a)?(e=xf(),_o=Au=$a=null,Qt=!1,e):null;switch(e){case"paste":return null;case"keypress":if(!(a.ctrlKey||a.altKey||a.metaKey)||a.ctrlKey&&a.altKey){if(a.char&&1<a.char.length)return a.char;if(a.which)return String.fromCharCode(a.which)}return null;case"compositionend":return Lf&&a.locale!=="ko"?null:a.data;default:return null}}function nd(e){var a=e&&e.nodeName&&e.nodeName.toLowerCase();return a==="input"?!!B0[e.type]:a==="textarea"?!0:!1}function vf(e,a,t,n){Um(n),a=Xo(a,"onChange"),0<a.length&&(t=new Tu("onChange","change",null,t,n),e.push({event:t,listeners:a}))}function E0(e){zf(e,0)}function cs(e){var a=Zn(e);if(Kd(a))return e}function N0(e,a){if(e==="change")return a}function rd(){ar&&(ar.detachEvent("onpropertychange",Cf),pr=ar=null)}function Cf(e){if(e.propertyName==="value"&&cs(pr)){var a=[];vf(a,pr,e,ku(e)),tf(E0,a)}}function O0(e,a,t){e==="focusin"?(rd(),ar=a,pr=t,ar.attachEvent("onpropertychange",Cf)):e==="focusout"&&rd()}function U0(e){if(e==="selectionchange"||e==="keyup"||e==="keydown")return cs(pr)}function H0(e,a){if(e==="click")return cs(a)}function q0(e,a){if(e==="input"||e==="change")return cs(a)}function W0(e,a){return e===a&&(e!==0||1/e===1/a)||e!==e&&a!==a}function mr(e,a){if(ma(e,a))return!0;if(typeof e!=="object"||e===null||typeof a!=="object"||a===null)return!1;var t=Object.keys(e),n=Object.keys(a);if(t.length!==n.length)return!1;for(n=0;n<t.length;n++){var r=t[n];if(!kl.call(a,r)||!ma(e[r],a[r]))return!1}return!0}function od(e){for(;e&&e.firstChild;)e=e.firstChild;return e}function sd(e,a){var t=od(e);e=0;for(var n;t;){if(t.nodeType===3){if(n=e+t.textContent.length,e<=a&&n>=a)return{node:t,offset:a-e};e=n}e:{for(;t;){if(t.nextSibling){t=t.nextSibling;break e}t=t.parentNode}t=void 0}t=od(t)}}function kf(e,a){return e&&a?e===a?!0:e&&e.nodeType===3?!1:a&&a.nodeType===3?kf(e,a.parentNode):("contains"in e)?e.contains(a):e.compareDocumentPosition?!!(e.compareDocumentPosition(a)&16):!1:!1}function Sf(){for(var e=window,a=Ho();a instanceof e.HTMLIFrameElement;){try{var t=typeof a.contentWindow.location.href==="string"}catch(n){t=!1}if(t)e=a.contentWindow;else break;a=Ho(e.document)}return a}function Ru(e){var a=e&&e.nodeName&&e.nodeName.toLowerCase();return a&&(a==="input"&&(e.type==="text"||e.type==="search"||e.type==="tel"||e.type==="url"||e.type==="password")||a==="textarea"||e.contentEditable==="true")}function V0(e){var a=Sf(),t=e.focusedElem,n=e.selectionRange;if(a!==t&&t&&t.ownerDocument&&kf(t.ownerDocument.documentElement,t)){if(n!==null&&Ru(t)){if(a=n.start,e=n.end,e===void 0&&(e=a),"selectionStart"in t)t.selectionStart=a,t.selectionEnd=Math.min(e,t.value.length);else if(e=(a=t.ownerDocument||document)&&a.defaultView||window,e.getSelection){e=e.getSelection();var r=t.textContent.length,o=Math.min(n.start,r);n=n.end===void 0?o:Math.min(n.end,r),!e.extend&&o>n&&(r=n,n=o,o=r),r=sd(t,o);var s=sd(t,n);r&&s&&(e.rangeCount!==1||e.anchorNode!==r.node||e.anchorOffset!==r.offset||e.focusNode!==s.node||e.focusOffset!==s.offset)&&(a=a.createRange(),a.setStart(r.node,r.offset),e.removeAllRanges(),o>n?(e.addRange(a),e.extend(s.node,s.offset)):(a.setEnd(s.node,s.offset),e.addRange(a)))}}a=[];for(e=t;e=e.parentNode;)e.nodeType===1&&a.push({element:e,left:e.scrollLeft,top:e.scrollTop});typeof t.focus==="function"&&t.focus();for(t=0;t<a.length;t++)e=a[t],e.element.scrollLeft=e.left,e.element.scrollTop=e.top}}function ld(e,a,t){var n=t.window===t?t.document:t.nodeType===9?t:t.ownerDocument;Vl||Zt==null||Zt!==Ho(n)||(n=Zt,("selectionStart"in n)&&Ru(n)?n={start:n.selectionStart,end:n.selectionEnd}:(n=(n.ownerDocument&&n.ownerDocument.defaultView||window).getSelection(),n={anchorNode:n.anchorNode,anchorOffset:n.anchorOffset,focusNode:n.focusNode,focusOffset:n.focusOffset}),tr&&mr(tr,n)||(tr=n,n=Xo(Wl,"onSelect"),0<n.length&&(a=new Tu("onSelect","select",null,a,t),e.push({event:a,listeners:n}),a.target=Zt)))}function Io(e,a){var t={};return t[e.toLowerCase()]=a.toLowerCase(),t["Webkit"+e]="webkit"+a,t["Moz"+e]="moz"+a,t}function ps(e){if(fl[e])return fl[e];if(!Yt[e])return e;var a=Yt[e],t;for(t in a)if(a.hasOwnProperty(t)&&t in Pf)return fl[e]=a[t];return e}function lt(e,a){_f.set(e,a),Rt(a,[e])}function id(e,a,t){var n=e.type||"unknown-event";e.currentTarget=t,Gm(n,a,void 0,e),e.currentTarget=null}function zf(e,a){a=(a&4)!==0;for(var t=0;t<e.length;t++){var n=e[t],r=n.event;n=n.listeners;e:{var o=void 0;if(a)for(var s=n.length-1;0<=s;s--){var l=n[s],u=l.instance,c=l.currentTarget;if(l=l.listener,u!==o&&r.isPropagationStopped())break e;id(r,l,c),o=u}else for(s=0;s<n.length;s++){if(l=n[s],u=l.instance,c=l.currentTarget,l=l.listener,u!==o&&r.isPropagationStopped())break e;id(r,l,c),o=u}}}if(Wo)throw e=Ol,Wo=!1,Ol=null,e}function ee(e,a){var t=a[Zl];t===void 0&&(t=a[Zl]=new Set);var n=e+"__bubble";t.has(n)||(Rf(a,e,2,!1),t.add(n))}function cl(e,a,t){var n=0;a&&(n|=4),Rf(t,e,n,a)}function Fu(e){if(!e[Co]){e[Co]=!0,qd.forEach(function(t){t!=="selectionchange"&&(j0.has(t)||cl(t,!1,e),cl(t,!0,e))});var a=e.nodeType===9?e:e.ownerDocument;a===null||a[Co]||(a[Co]=!0,cl("selectionchange",!1,a))}}function Rf(e,a,t,n){switch(gf(a)){case 1:var r=u0;break;case 4:r=i0;break;default:r=Mu}t=r.bind(null,a,t,e),r=void 0,!Nl||a!=="touchstart"&&a!=="touchmove"&&a!=="wheel"||(r=!0),n?r!==void 0?e.addEventListener(a,t,{capture:!0,passive:r}):e.addEventListener(a,t,!0):r!==void 0?e.addEventListener(a,t,{passive:r}):e.addEventListener(a,t,!1)}function pl(e,a,t,n,r){var o=n;if((a&1)===0&&(a&2)===0&&n!==null)e:for(;;){if(n===null)return;var s=n.tag;if(s===3||s===4){var l=n.stateNode.containerInfo;if(l===r||l.nodeType===8&&l.parentNode===r)break;if(s===4)for(s=n.return;s!==null;){var u=s.tag;if(u===3||u===4){if(u=s.stateNode.containerInfo,u===r||u.nodeType===8&&u.parentNode===r)return}s=s.return}for(;l!==null;){if(s=kt(l),s===null)return;if(u=s.tag,u===5||u===6){n=o=s;continue e}l=l.parentNode}}n=n.return}tf(function(){var c=o,m=ku(t),g=[];e:{var h=_f.get(e);if(h!==void 0){var x=Tu,v=e;switch(e){case"keypress":if(zo(t)===0)break e;case"keydown":case"keyup":x=k0;break;case"focusin":v="focus",x=dl;break;case"focusout":v="blur",x=dl;break;case"beforeblur":case"afterblur":x=dl;break;case"click":if(t.button===2)break e;case"auxclick":case"dblclick":case"mousedown":case"mousemove":case"mouseup":case"mouseout":case"mouseover":case"contextmenu":x=Yi;break;case"drag":case"dragend":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"dragstart":case"drop":x=c0;break;case"touchcancel":case"touchend":case"touchmove":case"touchstart":x=b0;break;case bf:case Mf:case Af:x=h0;break;case Tf:x=A0;break;case"scroll":x=d0;break;case"wheel":x=_0;break;case"copy":case"cut":case"paste":x=x0;break;case"gotpointercapture":case"lostpointercapture":case"pointercancel":case"pointerdown":case"pointermove":case"pointerout":case"pointerover":case"pointerup":x=ed}var k=(a&4)!==0,B=!k&&e==="scroll",f=k?h!==null?h+"Capture":null:h;k=[];for(var d=c,p;d!==null;){p=d;var w=p.stateNode;if(p.tag===5&&w!==null&&(p=w,f!==null&&(w=ir(d,f),w!=null&&k.push(hr(d,w,p)))),B)break;d=d.return}0<k.length&&(h=new x(h,v,null,t,m),g.push({event:h,listeners:k}))}}if((a&7)===0){e:{if(h=e==="mouseover"||e==="pointerover",x=e==="mouseout"||e==="pointerout",h&&t!==Bl&&(v=t.relatedTarget||t.fromElement)&&(kt(v)||v[vn]))break e;if(x||h){if(h=m.window===m?m:(h=m.ownerDocument)?h.defaultView||h.parentWindow:window,x){if(v=t.relatedTarget||t.toElement,x=c,v=v?kt(v):null,v!==null&&(B=Ft(v),v!==B||v.tag!==5&&v.tag!==6))v=null}else x=null,v=c;if(x!==v){if(k=Yi,w="onMouseLeave",f="onMouseEnter",d="mouse",e==="pointerout"||e==="pointerover")k=ed,w="onPointerLeave",f="onPointerEnter",d="pointer";if(B=x==null?h:Zn(x),p=v==null?h:Zn(v),h=new k(w,d+"leave",x,t,m),h.target=B,h.relatedTarget=p,w=null,kt(m)===c&&(k=new k(f,d+"enter",v,t,m),k.target=p,k.relatedTarget=B,w=k),B=w,x&&v)a:{k=x,f=v,d=0;for(p=k;p;p=Kt(p))d++;p=0;for(w=f;w;w=Kt(w))p++;for(;0<d-p;)k=Kt(k),d--;for(;0<p-d;)f=Kt(f),p--;for(;d--;){if(k===f||f!==null&&k===f.alternate)break a;k=Kt(k),f=Kt(f)}k=null}else k=null;x!==null&&dd(g,h,x,k,!1),v!==null&&B!==null&&dd(g,B,v,k,!0)}}}e:{if(h=c?Zn(c):window,x=h.nodeName&&h.nodeName.toLowerCase(),x==="select"||x==="input"&&h.type==="file")var A=N0;else if(nd(h))if(If)A=q0;else{A=U0;var F=O0}else(x=h.nodeName)&&x.toLowerCase()==="input"&&(h.type==="checkbox"||h.type==="radio")&&(A=H0);if(A&&(A=A(e,c))){vf(g,A,t,m);break e}F&&F(e,h,c),e==="focusout"&&(F=h._wrapperState)&&F.controlled&&h.type==="number"&&_l(h,"number",h.value)}switch(F=c?Zn(c):window,e){case"focusin":if(nd(F)||F.contentEditable==="true")Zt=F,Wl=c,tr=null;break;case"focusout":tr=Wl=Zt=null;break;case"mousedown":Vl=!0;break;case"contextmenu":case"mouseup":case"dragend":Vl=!1,ld(g,t,m);break;case"selectionchange":if(G0)break;case"keydown":case"keyup":ld(g,t,m)}var z;if(zu)e:{switch(e){case"compositionstart":var y="onCompositionStart";break e;case"compositionend":y="onCompositionEnd";break e;case"compositionupdate":y="onCompositionUpdate";break e}y=void 0}else Qt?wf(e,t)&&(y="onCompositionEnd"):e==="keydown"&&t.keyCode===229&&(y="onCompositionStart");if(y&&(Lf&&t.locale!=="ko"&&(Qt||y!=="onCompositionStart"?y==="onCompositionEnd"&&Qt&&(z=xf()):($a=m,Au=("value"in $a)?$a.value:$a.textContent,Qt=!0)),F=Xo(c,y),0<F.length&&(y=new Ji(y,e,null,t,m),g.push({event:y,listeners:F}),z?y.data=z:(z=yf(t),z!==null&&(y.data=z)))),z=R0?F0(e,t):D0(e,t))c=Xo(c,"onBeforeInput"),0<c.length&&(m=new Ji("onBeforeInput","beforeinput",null,t,m),g.push({event:m,listeners:c}),m.data=z)}zf(g,a)})}function hr(e,a,t){return{instance:e,listener:a,currentTarget:t}}function Xo(e,a){for(var t=a+"Capture",n=[];e!==null;){var r=e,o=r.stateNode;r.tag===5&&o!==null&&(r=o,o=ir(e,t),o!=null&&n.unshift(hr(e,o,r)),o=ir(e,a),o!=null&&n.push(hr(e,o,r))),e=e.return}return n}function Kt(e){if(e===null)return null;do e=e.return;while(e&&e.tag!==5);return e?e:null}function dd(e,a,t,n,r){for(var o=a._reactName,s=[];t!==null&&t!==n;){var l=t,u=l.alternate,c=l.stateNode;if(u!==null&&u===n)break;l.tag===5&&c!==null&&(l=c,r?(u=ir(t,o),u!=null&&s.unshift(hr(t,u,l))):r||(u=ir(t,o),u!=null&&s.push(hr(t,u,l)))),t=t.return}s.length!==0&&e.push({event:a,listeners:s})}function fd(e){return(typeof e==="string"?e:""+e).replace(K0,`
`).replace(X0,"")}function ko(e,a,t){if(a=fd(a),fd(e)!==a&&t)throw Error(C(425))}function $o(){}function $l(e,a){return e==="textarea"||e==="noscript"||typeof a.children==="string"||typeof a.children==="number"||typeof a.dangerouslySetInnerHTML==="object"&&a.dangerouslySetInnerHTML!==null&&a.dangerouslySetInnerHTML.__html!=null}function Z0(e){setTimeout(function(){throw e})}function ml(e,a){var t=a,n=0;do{var r=t.nextSibling;if(e.removeChild(t),r&&r.nodeType===8)if(t=r.data,t==="/$"){if(n===0){e.removeChild(r),cr(a);return}n--}else t!=="$"&&t!=="$?"&&t!=="$!"||n++;t=r}while(t);cr(a)}function et(e){for(;e!=null;e=e.nextSibling){var a=e.nodeType;if(a===1||a===3)break;if(a===8){if(a=e.data,a==="$"||a==="$!"||a==="$?")break;if(a==="/$")return null}}return e}function pd(e){e=e.previousSibling;for(var a=0;e;){if(e.nodeType===8){var t=e.data;if(t==="$"||t==="$!"||t==="$?"){if(a===0)return e;a--}else t==="/$"&&a++}e=e.previousSibling}return null}function kt(e){var a=e[Sa];if(a)return a;for(var t=e.parentNode;t;){if(a=t[vn]||t[Sa]){if(t=a.alternate,a.child!==null||t!==null&&t.child!==null)for(e=pd(e);e!==null;){if(t=e[Sa])return t;e=pd(e)}return a}e=t,t=e.parentNode}return null}function ms(e){return e=e[Sa]||e[vn],!e||e.tag!==5&&e.tag!==6&&e.tag!==13&&e.tag!==3?null:e}function Zn(e){if(e.tag===5||e.tag===6)return e.stateNode;throw Error(C(33))}function Du(e){return e[gr]||null}function ut(e){return{current:e}}function ae(e){0>Jt||(e.current=Yl[Jt],Yl[Jt]=null,Jt--)}function Q(e,a){Jt++,Yl[Jt]=e.current,e.current=a}function pn(e,a){var t=e.type.contextTypes;if(!t)return st;var n=e.stateNode;if(n&&n.__reactInternalMemoizedUnmaskedChildContext===a)return n.__reactInternalMemoizedMaskedChildContext;var r={},o;for(o in t)r[o]=a[o];return n&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=a,e.__reactInternalMemoizedMaskedChildContext=r),r}function He(e){return e=e.childContextTypes,e!==null&&e!==void 0}function Qo(){ae(Ue),ae(ze)}function md(e,a,t){if(ze.current!==st)throw Error(C(168));Q(ze,a),Q(Ue,t)}function Ff(e,a,t){var n=e.stateNode;if(a=a.childContextTypes,typeof n.getChildContext!=="function")return t;n=n.getChildContext();for(var r in n)if(!(r in a))throw Error(C(108,Bm(e)||"Unknown",r));return le({},t,n)}function Zo(e){return e=(e=e.stateNode)&&e.__reactInternalMemoizedMergedChildContext||st,At=ze.current,Q(ze,e),Q(Ue,Ue.current),!0}function hd(e,a,t){var n=e.stateNode;if(!n)throw Error(C(169));t?(e=Ff(e,a,At),n.__reactInternalMemoizedMergedChildContext=e,ae(Ue),ae(ze),Q(ze,e)):ae(Ue),Q(Ue,t)}function Df(e){za===null?za=[e]:za.push(e)}function eh(e){hs=!0,Df(e)}function it(){if(!hl&&za!==null){hl=!0;var e=0,a=j;try{var t=za;for(j=1;e<t.length;e++){var n=t[e];do n=n(!0);while(n!==null)}za=null,hs=!1}catch(r){throw za!==null&&(za=za.slice(e+1)),of(Su,it),r}finally{j=a,hl=!1}}return null}function It(e,a){en[an++]=Jo,en[an++]=Yo,Yo=e,Jo=a}function Bf(e,a,t){Ze[Ye++]=Ra,Ze[Ye++]=Fa,Ze[Ye++]=Tt,Tt=e;var n=Ra;e=Fa;var r=32-ca(n)-1;n&=~(1<<r),t+=1;var o=32-ca(a)+r;if(30<o){var s=r-r%5;o=(n&(1<<s)-1).toString(32),n>>=s,r-=s,Ra=1<<32-ca(a)+r|t<<r|n,Fa=o+e}else Ra=1<<o|t<<r|n,Fa=e}function Bu(e){e.return!==null&&(It(e,1),Bf(e,1,0))}function Eu(e){for(;e===Yo;)Yo=en[--an],en[an]=null,Jo=en[--an],en[an]=null;for(;e===Tt;)Tt=Ze[--Ye],Ze[Ye]=null,Fa=Ze[--Ye],Ze[Ye]=null,Ra=Ze[--Ye],Ze[Ye]=null}function Ef(e,a){var t=Je(5,null,null,0);t.elementType="DELETED",t.stateNode=a,t.return=e,a=e.deletions,a===null?(e.deletions=[t],e.flags|=16):a.push(t)}function gd(e,a){switch(e.tag){case 5:var t=e.type;return a=a.nodeType!==1||t.toLowerCase()!==a.nodeName.toLowerCase()?null:a,a!==null?(e.stateNode=a,Ge=e,Ve=et(a.firstChild),!0):!1;case 6:return a=e.pendingProps===""||a.nodeType!==3?null:a,a!==null?(e.stateNode=a,Ge=e,Ve=null,!0):!1;case 13:return a=a.nodeType!==8?null:a,a!==null?(t=Tt!==null?{id:Ra,overflow:Fa}:null,e.memoizedState={dehydrated:a,treeContext:t,retryLane:1073741824},t=Je(18,null,null,0),t.stateNode=a,t.return=e,e.child=t,Ge=e,Ve=null,!0):!1;default:return!1}}function Jl(e){return(e.mode&1)!==0&&(e.flags&128)===0}function eu(e){if(te){var a=Ve;if(a){var t=a;if(!gd(e,a)){if(Jl(e))throw Error(C(418));a=et(t.nextSibling);var n=Ge;a&&gd(e,a)?Ef(n,t):(e.flags=e.flags&-4097|2,te=!1,Ge=e)}}else{if(Jl(e))throw Error(C(418));e.flags=e.flags&-4097|2,te=!1,Ge=e}}}function xd(e){for(e=e.return;e!==null&&e.tag!==5&&e.tag!==3&&e.tag!==13;)e=e.return;Ge=e}function So(e){if(e!==Ge)return!1;if(!te)return xd(e),te=!0,!1;var a;if((a=e.tag!==3)&&!(a=e.tag!==5)&&(a=e.type,a=a!=="head"&&a!=="body"&&!$l(e.type,e.memoizedProps)),a&&(a=Ve)){if(Jl(e))throw Nf(),Error(C(418));for(;a;)Ef(e,a),a=et(a.nextSibling)}if(xd(e),e.tag===13){if(e=e.memoizedState,e=e!==null?e.dehydrated:null,!e)throw Error(C(317));e:{e=e.nextSibling;for(a=0;e;){if(e.nodeType===8){var t=e.data;if(t==="/$"){if(a===0){Ve=et(e.nextSibling);break e}a--}else t!=="$"&&t!=="$!"&&t!=="$?"||a++}e=e.nextSibling}Ve=null}}else Ve=Ge?et(e.stateNode.nextSibling):null;return!0}function Nf(){for(var e=Ve;e;)e=et(e.nextSibling)}function mn(){Ve=Ge=null,te=!1}function Nu(e){fa===null?fa=[e]:fa.push(e)}function On(e,a,t){if(e=t.ref,e!==null&&typeof e!=="function"&&typeof e!=="object"){if(t._owner){if(t=t._owner,t){if(t.tag!==1)throw Error(C(309));var n=t.stateNode}if(!n)throw Error(C(147,e));var r=n,o=""+e;if(a!==null&&a.ref!==null&&typeof a.ref==="function"&&a.ref._stringRef===o)return a.ref;return a=function(s){var l=r.refs;s===null?delete l[o]:l[o]=s},a._stringRef=o,a}if(typeof e!=="string")throw Error(C(284));if(!t._owner)throw Error(C(290,e))}return e}function Po(e,a){throw e=Object.prototype.toString.call(a),Error(C(31,e==="[object Object]"?"object with keys {"+Object.keys(a).join(", ")+"}":e))}function Ld(e){var a=e._init;return a(e._payload)}function Of(e){function a(f,d){if(e){var p=f.deletions;p===null?(f.deletions=[d],f.flags|=16):p.push(d)}}function t(f,d){if(!e)return null;for(;d!==null;)a(f,d),d=d.sibling;return null}function n(f,d){for(f=new Map;d!==null;)d.key!==null?f.set(d.key,d):f.set(d.index,d),d=d.sibling;return f}function r(f,d){return f=rt(f,d),f.index=0,f.sibling=null,f}function o(f,d,p){if(f.index=p,!e)return f.flags|=1048576,d;if(p=f.alternate,p!==null)return p=p.index,p<d?(f.flags|=2,d):p;return f.flags|=2,d}function s(f){return e&&f.alternate===null&&(f.flags|=2),f}function l(f,d,p,w){if(d===null||d.tag!==6)return d=Il(p,f.mode,w),d.return=f,d;return d=r(d,p),d.return=f,d}function u(f,d,p,w){var A=p.type;if(A===$t)return m(f,d,p.props.children,w,p.key);if(d!==null&&(d.elementType===A||typeof A==="object"&&A!==null&&A.$$typeof===Ga&&Ld(A)===d.type))return w=r(d,p.props),w.ref=On(f,d,p),w.return=f,w;return w=Uo(p.type,p.key,p.props,null,f.mode,w),w.ref=On(f,d,p),w.return=f,w}function c(f,d,p,w){if(d===null||d.tag!==4||d.stateNode.containerInfo!==p.containerInfo||d.stateNode.implementation!==p.implementation)return d=Cl(p,f.mode,w),d.return=f,d;return d=r(d,p.children||[]),d.return=f,d}function m(f,d,p,w,A){if(d===null||d.tag!==7)return d=Mt(p,f.mode,w,A),d.return=f,d;return d=r(d,p),d.return=f,d}function g(f,d,p){if(typeof d==="string"&&d!==""||typeof d==="number")return d=Il(""+d,f.mode,p),d.return=f,d;if(typeof d==="object"&&d!==null){switch(d.$$typeof){case ho:return p=Uo(d.type,d.key,d.props,null,f.mode,p),p.ref=On(f,null,d),p.return=f,p;case qn:return d=Cl(d,f.mode,p),d.return=f,d;case Ga:var w=d._init;return g(f,w(d._payload),p)}if(Vn(d)||Dn(d))return d=Mt(d,f.mode,p,null),d.return=f,d;Po(f,d)}return null}function h(f,d,p,w){var A=d!==null?d.key:null;if(typeof p==="string"&&p!==""||typeof p==="number")return A!==null?null:l(f,d,""+p,w);if(typeof p==="object"&&p!==null){switch(p.$$typeof){case ho:return p.key===A?u(f,d,p,w):null;case qn:return p.key===A?c(f,d,p,w):null;case Ga:return A=p._init,h(f,d,A(p._payload),w)}if(Vn(p)||Dn(p))return A!==null?null:m(f,d,p,w,null);Po(f,p)}return null}function x(f,d,p,w,A){if(typeof w==="string"&&w!==""||typeof w==="number")return f=f.get(p)||null,l(d,f,""+w,A);if(typeof w==="object"&&w!==null){switch(w.$$typeof){case ho:return f=f.get(w.key===null?p:w.key)||null,u(d,f,w,A);case qn:return f=f.get(w.key===null?p:w.key)||null,c(d,f,w,A);case Ga:var F=w._init;return x(f,d,p,F(w._payload),A)}if(Vn(w)||Dn(w))return f=f.get(p)||null,m(d,f,w,A,null);Po(d,w)}return null}function v(f,d,p,w){for(var A=null,F=null,z=d,y=d=0,re=null;z!==null&&y<p.length;y++){z.index>y?(re=z,z=null):re=z.sibling;var D=h(f,z,p[y],w);if(D===null){z===null&&(z=re);break}e&&z&&D.alternate===null&&a(f,z),d=o(D,d,y),F===null?A=D:F.sibling=D,F=D,z=re}if(y===p.length)return t(f,z),te&&It(f,y),A;if(z===null){for(;y<p.length;y++)z=g(f,p[y],w),z!==null&&(d=o(z,d,y),F===null?A=z:F.sibling=z,F=z);return te&&It(f,y),A}for(z=n(f,z);y<p.length;y++)re=x(z,f,y,p[y],w),re!==null&&(e&&re.alternate!==null&&z.delete(re.key===null?y:re.key),d=o(re,d,y),F===null?A=re:F.sibling=re,F=re);return e&&z.forEach(function(K){return a(f,K)}),te&&It(f,y),A}function k(f,d,p,w){var A=Dn(p);if(typeof A!=="function")throw Error(C(150));if(p=A.call(p),p==null)throw Error(C(151));for(var F=A=null,z=d,y=d=0,re=null,D=p.next();z!==null&&!D.done;y++,D=p.next()){z.index>y?(re=z,z=null):re=z.sibling;var K=h(f,z,D.value,w);if(K===null){z===null&&(z=re);break}e&&z&&K.alternate===null&&a(f,z),d=o(K,d,y),F===null?A=K:F.sibling=K,F=K,z=re}if(D.done)return t(f,z),te&&It(f,y),A;if(z===null){for(;!D.done;y++,D=p.next())D=g(f,D.value,w),D!==null&&(d=o(D,d,y),F===null?A=D:F.sibling=D,F=D);return te&&It(f,y),A}for(z=n(f,z);!D.done;y++,D=p.next())D=x(z,f,y,D.value,w),D!==null&&(e&&D.alternate!==null&&z.delete(D.key===null?y:D.key),d=o(D,d,y),F===null?A=D:F.sibling=D,F=D);return e&&z.forEach(function(Ua){return a(f,Ua)}),te&&It(f,y),A}function B(f,d,p,w){if(typeof p==="object"&&p!==null&&p.type===$t&&p.key===null&&(p=p.props.children),typeof p==="object"&&p!==null){switch(p.$$typeof){case ho:e:{for(var A=p.key,F=d;F!==null;){if(F.key===A){if(A=p.type,A===$t){if(F.tag===7){t(f,F.sibling),d=r(F,p.props.children),d.return=f,f=d;break e}}else if(F.elementType===A||typeof A==="object"&&A!==null&&A.$$typeof===Ga&&Ld(A)===F.type){t(f,F.sibling),d=r(F,p.props),d.ref=On(f,F,p),d.return=f,f=d;break e}t(f,F);break}else a(f,F);F=F.sibling}p.type===$t?(d=Mt(p.props.children,f.mode,w,p.key),d.return=f,f=d):(w=Uo(p.type,p.key,p.props,null,f.mode,w),w.ref=On(f,d,p),w.return=f,f=w)}return s(f);case qn:e:{for(F=p.key;d!==null;){if(d.key===F)if(d.tag===4&&d.stateNode.containerInfo===p.containerInfo&&d.stateNode.implementation===p.implementation){t(f,d.sibling),d=r(d,p.children||[]),d.return=f,f=d;break e}else{t(f,d);break}else a(f,d);d=d.sibling}d=Cl(p,f.mode,w),d.return=f,f=d}return s(f);case Ga:return F=p._init,B(f,d,F(p._payload),w)}if(Vn(p))return v(f,d,p,w);if(Dn(p))return k(f,d,p,w);Po(f,p)}return typeof p==="string"&&p!==""||typeof p==="number"?(p=""+p,d!==null&&d.tag===6?(t(f,d.sibling),d=r(d,p),d.return=f,f=d):(t(f,d),d=Il(p,f.mode,w),d.return=f,f=d),s(f)):t(f,d)}return B}function Uu(){Ou=tn=as=null}function Hu(e){var a=es.current;ae(es),e._currentValue=a}function au(e,a,t){for(;e!==null;){var n=e.alternate;if((e.childLanes&a)!==a?(e.childLanes|=a,n!==null&&(n.childLanes|=a)):n!==null&&(n.childLanes&a)!==a&&(n.childLanes|=a),e===t)break;e=e.return}}function dn(e,a){as=e,Ou=tn=null,e=e.dependencies,e!==null&&e.firstContext!==null&&((e.lanes&a)!==0&&(Oe=!0),e.firstContext=null)}function aa(e){var a=e._currentValue;if(Ou!==e)if(e={context:e,memoizedValue:a,next:null},tn===null){if(as===null)throw Error(C(308));tn=e,as.dependencies={lanes:0,firstContext:e}}else tn=tn.next=e;return a}function qu(e){St===null?St=[e]:St.push(e)}function Hf(e,a,t,n){var r=a.interleaved;return r===null?(t.next=t,qu(a)):(t.next=r.next,r.next=t),a.interleaved=t,Ea(e,n)}function Ea(e,a){e.lanes|=a;var t=e.alternate;t!==null&&(t.lanes|=a),t=e;for(e=e.return;e!==null;)e.childLanes|=a,t=e.alternate,t!==null&&(t.childLanes|=a),t=e,e=e.return;return t.tag===3?t.stateNode:null}function Wu(e){e.updateQueue={baseState:e.memoizedState,firstBaseUpdate:null,lastBaseUpdate:null,shared:{pending:null,interleaved:null,lanes:0},effects:null}}function qf(e,a){e=e.updateQueue,a.updateQueue===e&&(a.updateQueue={baseState:e.baseState,firstBaseUpdate:e.firstBaseUpdate,lastBaseUpdate:e.lastBaseUpdate,shared:e.shared,effects:e.effects})}function Da(e,a){return{eventTime:e,lane:a,tag:0,payload:null,callback:null,next:null}}function at(e,a,t){var n=e.updateQueue;if(n===null)return null;if(n=n.shared,(q&2)!==0){var r=n.pending;return r===null?a.next=a:(a.next=r.next,r.next=a),n.pending=a,Ea(e,t)}return r=n.interleaved,r===null?(a.next=a,qu(n)):(a.next=r.next,r.next=a),n.interleaved=a,Ea(e,t)}function Fo(e,a,t){if(a=a.updateQueue,a!==null&&(a=a.shared,(t&4194240)!==0)){var n=a.lanes;n&=e.pendingLanes,t|=n,a.lanes=t,Pu(e,t)}}function wd(e,a){var t=e.updateQueue,n=e.alternate;if(n!==null&&(n=n.updateQueue,t===n)){var r=null,o=null;if(t=t.firstBaseUpdate,t!==null){do{var s={eventTime:t.eventTime,lane:t.lane,tag:t.tag,payload:t.payload,callback:t.callback,next:null};o===null?r=o=s:o=o.next=s,t=t.next}while(t!==null);o===null?r=o=a:o=o.next=a}else r=o=a;t={baseState:n.baseState,firstBaseUpdate:r,lastBaseUpdate:o,shared:n.shared,effects:n.effects},e.updateQueue=t;return}e=t.lastBaseUpdate,e===null?t.firstBaseUpdate=a:e.next=a,t.lastBaseUpdate=a}function ts(e,a,t,n){var r=e.updateQueue;ja=!1;var o=r.firstBaseUpdate,s=r.lastBaseUpdate,l=r.shared.pending;if(l!==null){r.shared.pending=null;var u=l,c=u.next;u.next=null,s===null?o=c:s.next=c,s=u;var m=e.alternate;m!==null&&(m=m.updateQueue,l=m.lastBaseUpdate,l!==s&&(l===null?m.firstBaseUpdate=c:l.next=c,m.lastBaseUpdate=u))}if(o!==null){var g=r.baseState;s=0,m=c=u=null,l=o;do{var h=l.lane,x=l.eventTime;if((n&h)===h){m!==null&&(m=m.next={eventTime:x,lane:0,tag:l.tag,payload:l.payload,callback:l.callback,next:null});e:{var v=e,k=l;switch(h=a,x=t,k.tag){case 1:if(v=k.payload,typeof v==="function"){g=v.call(x,g,h);break e}g=v;break e;case 3:v.flags=v.flags&-65537|128;case 0:if(v=k.payload,h=typeof v==="function"?v.call(x,g,h):v,h===null||h===void 0)break e;g=le({},g,h);break e;case 2:ja=!0}}l.callback!==null&&l.lane!==0&&(e.flags|=64,h=r.effects,h===null?r.effects=[l]:h.push(l))}else x={eventTime:x,lane:h,tag:l.tag,payload:l.payload,callback:l.callback,next:null},m===null?(c=m=x,u=g):m=m.next=x,s|=h;if(l=l.next,l===null)if(l=r.shared.pending,l===null)break;else h=l,l=h.next,h.next=null,r.lastBaseUpdate=h,r.shared.pending=null}while(1);if(m===null&&(u=g),r.baseState=u,r.firstBaseUpdate=c,r.lastBaseUpdate=m,a=r.shared.interleaved,a!==null){r=a;do s|=r.lane,r=r.next;while(r!==a)}else o===null&&(r.shared.lanes=0);zt|=s,e.lanes=s,e.memoizedState=g}}function yd(e,a,t){if(e=a.effects,a.effects=null,e!==null)for(a=0;a<e.length;a++){var n=e[a],r=n.callback;if(r!==null){if(n.callback=null,n=t,typeof r!=="function")throw Error(C(191,r));r.call(n)}}}function Pt(e){if(e===Sr)throw Error(C(174));return e}function Vu(e,a){switch(Q(Lr,a),Q(xr,e),Q(ba,Sr),e=a.nodeType,e){case 9:case 11:a=(a=a.documentElement)?a.namespaceURI:Rl(null,"");break;default:e=e===8?a.parentNode:a,a=e.namespaceURI||null,e=e.tagName,a=Rl(a,e)}ae(ba),Q(ba,a)}function gn(){ae(ba),ae(xr),ae(Lr)}function Wf(e){Pt(Lr.current);var a=Pt(ba.current),t=Rl(a,e.type);a!==t&&(Q(xr,e),Q(ba,t))}function Gu(e){xr.current===e&&(ae(ba),ae(xr))}function ns(e){for(var a=e;a!==null;){if(a.tag===13){var t=a.memoizedState;if(t!==null&&(t=t.dehydrated,t===null||t.data==="$?"||t.data==="$!"))return a}else if(a.tag===19&&a.memoizedProps.revealOrder!==void 0){if((a.flags&128)!==0)return a}else if(a.child!==null){a.child.return=a,a=a.child;continue}if(a===e)break;for(;a.sibling===null;){if(a.return===null||a.return===e)return null;a=a.return}a.sibling.return=a.return,a=a.sibling}return null}function ju(){for(var e=0;e<gl.length;e++)gl[e]._workInProgressVersionPrimary=null;gl.length=0}function Ae(){throw Error(C(321))}function Ku(e,a){if(a===null)return!1;for(var t=0;t<a.length&&t<e.length;t++)if(!ma(e[t],a[t]))return!1;return!0}function Xu(e,a,t,n,r,o){if(_t=o,se=a,a.memoizedState=null,a.updateQueue=null,a.lanes=0,Do.current=e===null||e.memoizedState===null?sh:lh,e=t(n,r),nr){o=0;do{if(nr=!1,wr=0,25<=o)throw Error(C(301));o+=1,ye=xe=null,a.updateQueue=null,Do.current=uh,e=t(n,r)}while(nr)}if(Do.current=os,a=xe!==null&&xe.next!==null,_t=0,ye=xe=se=null,rs=!1,a)throw Error(C(300));return e}function $u(){var e=wr!==0;return wr=0,e}function ka(){var e={memoizedState:null,baseState:null,baseQueue:null,queue:null,next:null};return ye===null?se.memoizedState=ye=e:ye=ye.next=e,ye}function ta(){if(xe===null){var e=se.alternate;e=e!==null?e.memoizedState:null}else e=xe.next;var a=ye===null?se.memoizedState:ye.next;if(a!==null)ye=a,xe=e;else{if(e===null)throw Error(C(310));xe=e,e={memoizedState:xe.memoizedState,baseState:xe.baseState,baseQueue:xe.baseQueue,queue:xe.queue,next:null},ye===null?se.memoizedState=ye=e:ye=ye.next=e}return ye}function yr(e,a){return typeof a==="function"?a(e):a}function Ll(e){var a=ta(),t=a.queue;if(t===null)throw Error(C(311));t.lastRenderedReducer=e;var n=xe,r=n.baseQueue,o=t.pending;if(o!==null){if(r!==null){var s=r.next;r.next=o.next,o.next=s}n.baseQueue=r=o,t.pending=null}if(r!==null){o=r.next,n=n.baseState;var l=s=null,u=null,c=o;do{var m=c.lane;if((_t&m)===m)u!==null&&(u=u.next={lane:0,action:c.action,hasEagerState:c.hasEagerState,eagerState:c.eagerState,next:null}),n=c.hasEagerState?c.eagerState:e(n,c.action);else{var g={lane:m,action:c.action,hasEagerState:c.hasEagerState,eagerState:c.eagerState,next:null};u===null?(l=u=g,s=n):u=u.next=g,se.lanes|=m,zt|=m}c=c.next}while(c!==null&&c!==o);u===null?s=n:u.next=l,ma(n,a.memoizedState)||(Oe=!0),a.memoizedState=n,a.baseState=s,a.baseQueue=u,t.lastRenderedState=n}if(e=t.interleaved,e!==null){r=e;do o=r.lane,se.lanes|=o,zt|=o,r=r.next;while(r!==e)}else r===null&&(t.lanes=0);return[a.memoizedState,t.dispatch]}function wl(e){var a=ta(),t=a.queue;if(t===null)throw Error(C(311));t.lastRenderedReducer=e;var{dispatch:n,pending:r}=t,o=a.memoizedState;if(r!==null){t.pending=null;var s=r=r.next;do o=e(o,s.action),s=s.next;while(s!==r);ma(o,a.memoizedState)||(Oe=!0),a.memoizedState=o,a.baseQueue===null&&(a.baseState=o),t.lastRenderedState=o}return[o,n]}function Vf(){}function Gf(e,a){var t=se,n=ta(),r=a(),o=!ma(n.memoizedState,r);if(o&&(n.memoizedState=r,Oe=!0),n=n.queue,Qu(Xf.bind(null,t,n,e),[e]),n.getSnapshot!==a||o||ye!==null&&ye.memoizedState.tag&1){if(t.flags|=2048,vr(9,Kf.bind(null,t,n,r,a),void 0,null),ve===null)throw Error(C(349));(_t&30)!==0||jf(t,a,r)}return r}function jf(e,a,t){e.flags|=16384,e={getSnapshot:a,value:t},a=se.updateQueue,a===null?(a={lastEffect:null,stores:null},se.updateQueue=a,a.stores=[e]):(t=a.stores,t===null?a.stores=[e]:t.push(e))}function Kf(e,a,t,n){a.value=t,a.getSnapshot=n,$f(a)&&Qf(e)}function Xf(e,a,t){return t(function(){$f(a)&&Qf(e)})}function $f(e){var a=e.getSnapshot;e=e.value;try{var t=a();return!ma(e,t)}catch(n){return!0}}function Qf(e){var a=Ea(e,1);a!==null&&pa(a,e,1,-1)}function vd(e){var a=ka();return typeof e==="function"&&(e=e()),a.memoizedState=a.baseState=e,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:yr,lastRenderedState:e},a.queue=e,e=e.dispatch=oh.bind(null,se,e),[a.memoizedState,e]}function vr(e,a,t,n){return e={tag:e,create:a,destroy:t,deps:n,next:null},a=se.updateQueue,a===null?(a={lastEffect:null,stores:null},se.updateQueue=a,a.lastEffect=e.next=e):(t=a.lastEffect,t===null?a.lastEffect=e.next=e:(n=t.next,t.next=e,e.next=n,a.lastEffect=e)),e}function Zf(){return ta().memoizedState}function Bo(e,a,t,n){var r=ka();se.flags|=e,r.memoizedState=vr(1|a,t,void 0,n===void 0?null:n)}function gs(e,a,t,n){var r=ta();n=n===void 0?null:n;var o=void 0;if(xe!==null){var s=xe.memoizedState;if(o=s.destroy,n!==null&&Ku(n,s.deps)){r.memoizedState=vr(a,t,o,n);return}}se.flags|=e,r.memoizedState=vr(1|a,t,o,n)}function Id(e,a){return Bo(8390656,8,e,a)}function Qu(e,a){return gs(2048,8,e,a)}function Yf(e,a){return gs(4,2,e,a)}function Jf(e,a){return gs(4,4,e,a)}function ec(e,a){if(typeof a==="function")return e=e(),a(e),function(){a(null)};if(a!==null&&a!==void 0)return e=e(),a.current=e,function(){a.current=null}}function ac(e,a,t){return t=t!==null&&t!==void 0?t.concat([e]):null,gs(4,4,ec.bind(null,a,e),t)}function Zu(){}function tc(e,a){var t=ta();a=a===void 0?null:a;var n=t.memoizedState;if(n!==null&&a!==null&&Ku(a,n[1]))return n[0];return t.memoizedState=[e,a],e}function nc(e,a){var t=ta();a=a===void 0?null:a;var n=t.memoizedState;if(n!==null&&a!==null&&Ku(a,n[1]))return n[0];return e=e(),t.memoizedState=[e,a],e}function rc(e,a,t){if((_t&21)===0)return e.baseState&&(e.baseState=!1,Oe=!0),e.memoizedState=t;return ma(t,a)||(t=uf(),se.lanes|=t,zt|=t,e.baseState=!0),a}function nh(e,a){var t=j;j=t!==0&&4>t?t:4,e(!0);var n=xl.transition;xl.transition={};try{e(!1),a()}finally{j=t,xl.transition=n}}function oc(){return ta().memoizedState}function rh(e,a,t){var n=nt(e);if(t={lane:n,action:t,hasEagerState:!1,eagerState:null,next:null},sc(e))lc(a,t);else if(t=Hf(e,a,t,n),t!==null){var r=De();pa(t,e,n,r),uc(t,a,n)}}function oh(e,a,t){var n=nt(e),r={lane:n,action:t,hasEagerState:!1,eagerState:null,next:null};if(sc(e))lc(a,r);else{var o=e.alternate;if(e.lanes===0&&(o===null||o.lanes===0)&&(o=a.lastRenderedReducer,o!==null))try{var s=a.lastRenderedState,l=o(s,t);if(r.hasEagerState=!0,r.eagerState=l,ma(l,s)){var u=a.interleaved;u===null?(r.next=r,qu(a)):(r.next=u.next,u.next=r),a.interleaved=r;return}}catch(c){}finally{}t=Hf(e,a,r,n),t!==null&&(r=De(),pa(t,e,n,r),uc(t,a,n))}}function sc(e){var a=e.alternate;return e===se||a!==null&&a===se}function lc(e,a){nr=rs=!0;var t=e.pending;t===null?a.next=a:(a.next=t.next,t.next=a),e.pending=a}function uc(e,a,t){if((t&4194240)!==0){var n=a.lanes;n&=e.pendingLanes,t|=n,a.lanes=t,Pu(e,t)}}function ia(e,a){if(e&&e.defaultProps){a=le({},a),e=e.defaultProps;for(var t in e)a[t]===void 0&&(a[t]=e[t]);return a}return a}function tu(e,a,t,n){a=e.memoizedState,t=t(n,a),t=t===null||t===void 0?a:le({},a,t),e.memoizedState=t,e.lanes===0&&(e.updateQueue.baseState=t)}function Cd(e,a,t,n,r,o,s){return e=e.stateNode,typeof e.shouldComponentUpdate==="function"?e.shouldComponentUpdate(n,o,s):a.prototype&&a.prototype.isPureReactComponent?!mr(t,n)||!mr(r,o):!0}function ic(e,a,t){var n=!1,r=st,o=a.contextType;return typeof o==="object"&&o!==null?o=aa(o):(r=He(a)?At:ze.current,n=a.contextTypes,o=(n=n!==null&&n!==void 0)?pn(e,r):st),a=new a(t,o),e.memoizedState=a.state!==null&&a.state!==void 0?a.state:null,a.updater=xs,e.stateNode=a,a._reactInternals=e,n&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=r,e.__reactInternalMemoizedMaskedChildContext=o),a}function kd(e,a,t,n){e=a.state,typeof a.componentWillReceiveProps==="function"&&a.componentWillReceiveProps(t,n),typeof a.UNSAFE_componentWillReceiveProps==="function"&&a.UNSAFE_componentWillReceiveProps(t,n),a.state!==e&&xs.enqueueReplaceState(a,a.state,null)}function nu(e,a,t,n){var r=e.stateNode;r.props=t,r.state=e.memoizedState,r.refs={},Wu(e);var o=a.contextType;typeof o==="object"&&o!==null?r.context=aa(o):(o=He(a)?At:ze.current,r.context=pn(e,o)),r.state=e.memoizedState,o=a.getDerivedStateFromProps,typeof o==="function"&&(tu(e,a,o,t),r.state=e.memoizedState),typeof a.getDerivedStateFromProps==="function"||typeof r.getSnapshotBeforeUpdate==="function"||typeof r.UNSAFE_componentWillMount!=="function"&&typeof r.componentWillMount!=="function"||(a=r.state,typeof r.componentWillMount==="function"&&r.componentWillMount(),typeof r.UNSAFE_componentWillMount==="function"&&r.UNSAFE_componentWillMount(),a!==r.state&&xs.enqueueReplaceState(r,r.state,null),ts(e,t,r,n),r.state=e.memoizedState),typeof r.componentDidMount==="function"&&(e.flags|=4194308)}function xn(e,a){try{var t="",n=a;do t+=Dm(n),n=n.return;while(n);var r=t}catch(o){r=`
Error generating stack: `+o.message+`
`+o.stack}return{value:e,source:a,stack:r,digest:null}}function yl(e,a,t){return{value:e,source:null,stack:t!=null?t:null,digest:a!=null?a:null}}function ru(e,a){try{console.error(a.value)}catch(t){setTimeout(function(){throw t})}}function dc(e,a,t){t=Da(-1,t),t.tag=3,t.payload={element:null};var n=a.value;return t.callback=function(){ls||(ls=!0,mu=n),ru(e,a)},t}function fc(e,a,t){t=Da(-1,t),t.tag=3;var n=e.type.getDerivedStateFromError;if(typeof n==="function"){var r=a.value;t.payload=function(){return n(r)},t.callback=function(){ru(e,a)}}var o=e.stateNode;return o!==null&&typeof o.componentDidCatch==="function"&&(t.callback=function(){ru(e,a),typeof n!=="function"&&(tt===null?tt=new Set([this]):tt.add(this));var s=a.stack;this.componentDidCatch(a.value,{componentStack:s!==null?s:""})}),t}function Sd(e,a,t){var n=e.pingCache;if(n===null){n=e.pingCache=new ih;var r=new Set;n.set(a,r)}else r=n.get(a),r===void 0&&(r=new Set,n.set(a,r));r.has(t)||(r.add(t),e=kh.bind(null,e,a,t),a.then(e,e))}function Pd(e){do{var a;if(a=e.tag===13)a=e.memoizedState,a=a!==null?a.dehydrated!==null?!0:!1:!0;if(a)return e;e=e.return}while(e!==null);return null}function bd(e,a,t,n,r){if((e.mode&1)===0)return e===a?e.flags|=65536:(e.flags|=128,t.flags|=131072,t.flags&=-52805,t.tag===1&&(t.alternate===null?t.tag=17:(a=Da(-1,1),a.tag=2,at(t,a,1))),t.lanes|=1),e;return e.flags|=65536,e.lanes=r,e}function Fe(e,a,t,n){a.child=e===null?Uf(a,null,t,n):hn(a,e.child,t,n)}function Md(e,a,t,n,r){t=t.render;var o=a.ref;if(dn(a,r),n=Xu(e,a,t,n,o,r),t=$u(),e!==null&&!Oe)return a.updateQueue=e.updateQueue,a.flags&=-2053,e.lanes&=~r,Na(e,a,r);return te&&t&&Bu(a),a.flags|=1,Fe(e,a,n,r),a.child}function Ad(e,a,t,n,r){if(e===null){var o=t.type;if(typeof o==="function"&&!ri(o)&&o.defaultProps===void 0&&t.compare===null&&t.defaultProps===void 0)return a.tag=15,a.type=o,cc(e,a,o,n,r);return e=Uo(t.type,null,n,a,a.mode,r),e.ref=a.ref,e.return=a,a.child=e}if(o=e.child,(e.lanes&r)===0){var s=o.memoizedProps;if(t=t.compare,t=t!==null?t:mr,t(s,n)&&e.ref===a.ref)return Na(e,a,r)}return a.flags|=1,e=rt(o,n),e.ref=a.ref,e.return=a,a.child=e}function cc(e,a,t,n,r){if(e!==null){var o=e.memoizedProps;if(mr(o,n)&&e.ref===a.ref)if(Oe=!1,a.pendingProps=n=o,(e.lanes&r)!==0)(e.flags&131072)!==0&&(Oe=!0);else return a.lanes=e.lanes,Na(e,a,r)}return ou(e,a,t,n,r)}function pc(e,a,t){var n=a.pendingProps,r=n.children,o=e!==null?e.memoizedState:null;if(n.mode==="hidden")if((a.mode&1)===0)a.memoizedState={baseLanes:0,cachePool:null,transitions:null},Q(rn,We),We|=t;else{if((t&1073741824)===0)return e=o!==null?o.baseLanes|t:t,a.lanes=a.childLanes=1073741824,a.memoizedState={baseLanes:e,cachePool:null,transitions:null},a.updateQueue=null,Q(rn,We),We|=e,null;a.memoizedState={baseLanes:0,cachePool:null,transitions:null},n=o!==null?o.baseLanes:t,Q(rn,We),We|=n}else o!==null?(n=o.baseLanes|t,a.memoizedState=null):n=t,Q(rn,We),We|=n;return Fe(e,a,r,t),a.child}function mc(e,a){var t=a.ref;if(e===null&&t!==null||e!==null&&e.ref!==t)a.flags|=512,a.flags|=2097152}function ou(e,a,t,n,r){var o=He(t)?At:ze.current;if(o=pn(a,o),dn(a,r),t=Xu(e,a,t,n,o,r),n=$u(),e!==null&&!Oe)return a.updateQueue=e.updateQueue,a.flags&=-2053,e.lanes&=~r,Na(e,a,r);return te&&n&&Bu(a),a.flags|=1,Fe(e,a,t,r),a.child}function Td(e,a,t,n,r){if(He(t)){var o=!0;Zo(a)}else o=!1;if(dn(a,r),a.stateNode===null)Eo(e,a),ic(a,t,n),nu(a,t,n,r),n=!0;else if(e===null){var{stateNode:s,memoizedProps:l}=a;s.props=l;var u=s.context,c=t.contextType;typeof c==="object"&&c!==null?c=aa(c):(c=He(t)?At:ze.current,c=pn(a,c));var m=t.getDerivedStateFromProps,g=typeof m==="function"||typeof s.getSnapshotBeforeUpdate==="function";g||typeof s.UNSAFE_componentWillReceiveProps!=="function"&&typeof s.componentWillReceiveProps!=="function"||(l!==n||u!==c)&&kd(a,s,n,c),ja=!1;var h=a.memoizedState;s.state=h,ts(a,n,s,r),u=a.memoizedState,l!==n||h!==u||Ue.current||ja?(typeof m==="function"&&(tu(a,t,m,n),u=a.memoizedState),(l=ja||Cd(a,t,l,n,h,u,c))?(g||typeof s.UNSAFE_componentWillMount!=="function"&&typeof s.componentWillMount!=="function"||(typeof s.componentWillMount==="function"&&s.componentWillMount(),typeof s.UNSAFE_componentWillMount==="function"&&s.UNSAFE_componentWillMount()),typeof s.componentDidMount==="function"&&(a.flags|=4194308)):(typeof s.componentDidMount==="function"&&(a.flags|=4194308),a.memoizedProps=n,a.memoizedState=u),s.props=n,s.state=u,s.context=c,n=l):(typeof s.componentDidMount==="function"&&(a.flags|=4194308),n=!1)}else{s=a.stateNode,qf(e,a),l=a.memoizedProps,c=a.type===a.elementType?l:ia(a.type,l),s.props=c,g=a.pendingProps,h=s.context,u=t.contextType,typeof u==="object"&&u!==null?u=aa(u):(u=He(t)?At:ze.current,u=pn(a,u));var x=t.getDerivedStateFromProps;(m=typeof x==="function"||typeof s.getSnapshotBeforeUpdate==="function")||typeof s.UNSAFE_componentWillReceiveProps!=="function"&&typeof s.componentWillReceiveProps!=="function"||(l!==g||h!==u)&&kd(a,s,n,u),ja=!1,h=a.memoizedState,s.state=h,ts(a,n,s,r);var v=a.memoizedState;l!==g||h!==v||Ue.current||ja?(typeof x==="function"&&(tu(a,t,x,n),v=a.memoizedState),(c=ja||Cd(a,t,c,n,h,v,u)||!1)?(m||typeof s.UNSAFE_componentWillUpdate!=="function"&&typeof s.componentWillUpdate!=="function"||(typeof s.componentWillUpdate==="function"&&s.componentWillUpdate(n,v,u),typeof s.UNSAFE_componentWillUpdate==="function"&&s.UNSAFE_componentWillUpdate(n,v,u)),typeof s.componentDidUpdate==="function"&&(a.flags|=4),typeof s.getSnapshotBeforeUpdate==="function"&&(a.flags|=1024)):(typeof s.componentDidUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(a.flags|=4),typeof s.getSnapshotBeforeUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(a.flags|=1024),a.memoizedProps=n,a.memoizedState=v),s.props=n,s.state=v,s.context=u,n=c):(typeof s.componentDidUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(a.flags|=4),typeof s.getSnapshotBeforeUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(a.flags|=1024),n=!1)}return su(e,a,t,n,o,r)}function su(e,a,t,n,r,o){mc(e,a);var s=(a.flags&128)!==0;if(!n&&!s)return r&&hd(a,t,!1),Na(e,a,o);n=a.stateNode,dh.current=a;var l=s&&typeof t.getDerivedStateFromError!=="function"?null:n.render();return a.flags|=1,e!==null&&s?(a.child=hn(a,e.child,null,o),a.child=hn(a,null,l,o)):Fe(e,a,l,o),a.memoizedState=n.state,r&&hd(a,t,!0),a.child}function hc(e){var a=e.stateNode;a.pendingContext?md(e,a.pendingContext,a.pendingContext!==a.context):a.context&&md(e,a.context,!1),Vu(e,a.containerInfo)}function _d(e,a,t,n,r){return mn(),Nu(r),a.flags|=256,Fe(e,a,t,n),a.child}function uu(e){return{baseLanes:e,cachePool:null,transitions:null}}function gc(e,a,t){var n=a.pendingProps,r=oe.current,o=!1,s=(a.flags&128)!==0,l;if((l=s)||(l=e!==null&&e.memoizedState===null?!1:(r&2)!==0),l)o=!0,a.flags&=-129;else if(e===null||e.memoizedState!==null)r|=1;if(Q(oe,r&1),e===null){if(eu(a),e=a.memoizedState,e!==null&&(e=e.dehydrated,e!==null))return(a.mode&1)===0?a.lanes=1:e.data==="$!"?a.lanes=8:a.lanes=1073741824,null;return s=n.children,e=n.fallback,o?(n=a.mode,o=a.child,s={mode:"hidden",children:s},(n&1)===0&&o!==null?(o.childLanes=0,o.pendingProps=s):o=vs(s,n,0,null),e=Mt(e,n,t,null),o.return=a,e.return=a,o.sibling=e,a.child=o,a.child.memoizedState=uu(t),a.memoizedState=lu,e):Yu(a,s)}if(r=e.memoizedState,r!==null&&(l=r.dehydrated,l!==null))return fh(e,a,s,n,l,r,t);if(o){o=n.fallback,s=a.mode,r=e.child,l=r.sibling;var u={mode:"hidden",children:n.children};return(s&1)===0&&a.child!==r?(n=a.child,n.childLanes=0,n.pendingProps=u,a.deletions=null):(n=rt(r,u),n.subtreeFlags=r.subtreeFlags&14680064),l!==null?o=rt(l,o):(o=Mt(o,s,t,null),o.flags|=2),o.return=a,n.return=a,n.sibling=o,a.child=n,n=o,o=a.child,s=e.child.memoizedState,s=s===null?uu(t):{baseLanes:s.baseLanes|t,cachePool:null,transitions:s.transitions},o.memoizedState=s,o.childLanes=e.childLanes&~t,a.memoizedState=lu,n}return o=e.child,e=o.sibling,n=rt(o,{mode:"visible",children:n.children}),(a.mode&1)===0&&(n.lanes=t),n.return=a,n.sibling=null,e!==null&&(t=a.deletions,t===null?(a.deletions=[e],a.flags|=16):t.push(e)),a.child=n,a.memoizedState=null,n}function Yu(e,a){return a=vs({mode:"visible",children:a},e.mode,0,null),a.return=e,e.child=a}function bo(e,a,t,n){return n!==null&&Nu(n),hn(a,e.child,null,t),e=Yu(a,a.pendingProps.children),e.flags|=2,a.memoizedState=null,e}function fh(e,a,t,n,r,o,s){if(t){if(a.flags&256)return a.flags&=-257,n=yl(Error(C(422))),bo(e,a,s,n);if(a.memoizedState!==null)return a.child=e.child,a.flags|=128,null;return o=n.fallback,r=a.mode,n=vs({mode:"visible",children:n.children},r,0,null),o=Mt(o,r,s,null),o.flags|=2,n.return=a,o.return=a,n.sibling=o,a.child=n,(a.mode&1)!==0&&hn(a,e.child,null,s),a.child.memoizedState=uu(s),a.memoizedState=lu,o}if((a.mode&1)===0)return bo(e,a,s,null);if(r.data==="$!"){if(n=r.nextSibling&&r.nextSibling.dataset,n)var l=n.dgst;return n=l,o=Error(C(419)),n=yl(o,n,void 0),bo(e,a,s,n)}if(l=(s&e.childLanes)!==0,Oe||l){if(n=ve,n!==null){switch(s&-s){case 4:r=2;break;case 16:r=8;break;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:r=32;break;case 536870912:r=268435456;break;default:r=0}r=(r&(n.suspendedLanes|s))!==0?0:r,r!==0&&r!==o.retryLane&&(o.retryLane=r,Ea(e,r),pa(n,e,r,-1))}return ni(),n=yl(Error(C(421))),bo(e,a,s,n)}if(r.data==="$?")return a.flags|=128,a.child=e.child,a=Sh.bind(null,e),r._reactRetry=a,null;return e=o.treeContext,Ve=et(r.nextSibling),Ge=a,te=!0,fa=null,e!==null&&(Ze[Ye++]=Ra,Ze[Ye++]=Fa,Ze[Ye++]=Tt,Ra=e.id,Fa=e.overflow,Tt=a),a=Yu(a,n.children),a.flags|=4096,a}function zd(e,a,t){e.lanes|=a;var n=e.alternate;n!==null&&(n.lanes|=a),au(e.return,a,t)}function vl(e,a,t,n,r){var o=e.memoizedState;o===null?e.memoizedState={isBackwards:a,rendering:null,renderingStartTime:0,last:n,tail:t,tailMode:r}:(o.isBackwards=a,o.rendering=null,o.renderingStartTime=0,o.last=n,o.tail=t,o.tailMode=r)}function xc(e,a,t){var n=a.pendingProps,r=n.revealOrder,o=n.tail;if(Fe(e,a,n.children,t),n=oe.current,(n&2)!==0)n=n&1|2,a.flags|=128;else{if(e!==null&&(e.flags&128)!==0)e:for(e=a.child;e!==null;){if(e.tag===13)e.memoizedState!==null&&zd(e,t,a);else if(e.tag===19)zd(e,t,a);else if(e.child!==null){e.child.return=e,e=e.child;continue}if(e===a)break e;for(;e.sibling===null;){if(e.return===null||e.return===a)break e;e=e.return}e.sibling.return=e.return,e=e.sibling}n&=1}if(Q(oe,n),(a.mode&1)===0)a.memoizedState=null;else switch(r){case"forwards":t=a.child;for(r=null;t!==null;)e=t.alternate,e!==null&&ns(e)===null&&(r=t),t=t.sibling;t=r,t===null?(r=a.child,a.child=null):(r=t.sibling,t.sibling=null),vl(a,!1,r,t,o);break;case"backwards":t=null,r=a.child;for(a.child=null;r!==null;){if(e=r.alternate,e!==null&&ns(e)===null){a.child=r;break}e=r.sibling,r.sibling=t,t=r,r=e}vl(a,!0,t,null,o);break;case"together":vl(a,!1,null,null,void 0);break;default:a.memoizedState=null}return a.child}function Eo(e,a){(a.mode&1)===0&&e!==null&&(e.alternate=null,a.alternate=null,a.flags|=2)}function Na(e,a,t){if(e!==null&&(a.dependencies=e.dependencies),zt|=a.lanes,(t&a.childLanes)===0)return null;if(e!==null&&a.child!==e.child)throw Error(C(153));if(a.child!==null){e=a.child,t=rt(e,e.pendingProps),a.child=t;for(t.return=a;e.sibling!==null;)e=e.sibling,t=t.sibling=rt(e,e.pendingProps),t.return=a;t.sibling=null}return a.child}function ch(e,a,t){switch(a.tag){case 3:hc(a),mn();break;case 5:Wf(a);break;case 1:He(a.type)&&Zo(a);break;case 4:Vu(a,a.stateNode.containerInfo);break;case 10:var n=a.type._context,r=a.memoizedProps.value;Q(es,n._currentValue),n._currentValue=r;break;case 13:if(n=a.memoizedState,n!==null){if(n.dehydrated!==null)return Q(oe,oe.current&1),a.flags|=128,null;if((t&a.child.childLanes)!==0)return gc(e,a,t);return Q(oe,oe.current&1),e=Na(e,a,t),e!==null?e.sibling:null}Q(oe,oe.current&1);break;case 19:if(n=(t&a.childLanes)!==0,(e.flags&128)!==0){if(n)return xc(e,a,t);a.flags|=128}if(r=a.memoizedState,r!==null&&(r.rendering=null,r.tail=null,r.lastEffect=null),Q(oe,oe.current),n)break;else return null;case 22:case 23:return a.lanes=0,pc(e,a,t)}return Na(e,a,t)}function Un(e,a){if(!te)switch(e.tailMode){case"hidden":a=e.tail;for(var t=null;a!==null;)a.alternate!==null&&(t=a),a=a.sibling;t===null?e.tail=null:t.sibling=null;break;case"collapsed":t=e.tail;for(var n=null;t!==null;)t.alternate!==null&&(n=t),t=t.sibling;n===null?a||e.tail===null?e.tail=null:e.tail.sibling=null:n.sibling=null}}function Te(e){var a=e.alternate!==null&&e.alternate.child===e.child,t=0,n=0;if(a)for(var r=e.child;r!==null;)t|=r.lanes|r.childLanes,n|=r.subtreeFlags&14680064,n|=r.flags&14680064,r.return=e,r=r.sibling;else for(r=e.child;r!==null;)t|=r.lanes|r.childLanes,n|=r.subtreeFlags,n|=r.flags,r.return=e,r=r.sibling;return e.subtreeFlags|=n,e.childLanes=t,a}function ph(e,a,t){var n=a.pendingProps;switch(Eu(a),a.tag){case 2:case 16:case 15:case 0:case 11:case 7:case 8:case 12:case 9:case 14:return Te(a),null;case 1:return He(a.type)&&Qo(),Te(a),null;case 3:if(n=a.stateNode,gn(),ae(Ue),ae(ze),ju(),n.pendingContext&&(n.context=n.pendingContext,n.pendingContext=null),e===null||e.child===null)So(a)?a.flags|=4:e===null||e.memoizedState.isDehydrated&&(a.flags&256)===0||(a.flags|=1024,fa!==null&&(xu(fa),fa=null));return iu(e,a),Te(a),null;case 5:Gu(a);var r=Pt(Lr.current);if(t=a.type,e!==null&&a.stateNode!=null)wc(e,a,t,n,r),e.ref!==a.ref&&(a.flags|=512,a.flags|=2097152);else{if(!n){if(a.stateNode===null)throw Error(C(166));return Te(a),null}if(e=Pt(ba.current),So(a)){n=a.stateNode,t=a.type;var o=a.memoizedProps;switch(n[Sa]=a,n[gr]=o,e=(a.mode&1)!==0,t){case"dialog":ee("cancel",n),ee("close",n);break;case"iframe":case"object":case"embed":ee("load",n);break;case"video":case"audio":for(r=0;r<Qn.length;r++)ee(Qn[r],n);break;case"source":ee("error",n);break;case"img":case"image":case"link":ee("error",n),ee("load",n);break;case"details":ee("toggle",n);break;case"input":qi(n,o),ee("invalid",n);break;case"select":n._wrapperState={wasMultiple:!!o.multiple},ee("invalid",n);break;case"textarea":Vi(n,o),ee("invalid",n)}Fl(t,o),r=null;for(var s in o)if(o.hasOwnProperty(s)){var l=o[s];s==="children"?typeof l==="string"?n.textContent!==l&&(o.suppressHydrationWarning!==!0&&ko(n.textContent,l,e),r=["children",l]):typeof l==="number"&&n.textContent!==""+l&&(o.suppressHydrationWarning!==!0&&ko(n.textContent,l,e),r=["children",""+l]):lr.hasOwnProperty(s)&&l!=null&&s==="onScroll"&&ee("scroll",n)}switch(t){case"input":go(n),Wi(n,o,!0);break;case"textarea":go(n),Gi(n);break;case"select":case"option":break;default:typeof o.onClick==="function"&&(n.onclick=$o)}n=r,a.updateQueue=n,n!==null&&(a.flags|=4)}else{s=r.nodeType===9?r:r.ownerDocument,e==="http://www.w3.org/1999/xhtml"&&(e=Qd(t)),e==="http://www.w3.org/1999/xhtml"?t==="script"?(e=s.createElement("div"),e.innerHTML="<script></script>",e=e.removeChild(e.firstChild)):typeof n.is==="string"?e=s.createElement(t,{is:n.is}):(e=s.createElement(t),t==="select"&&(s=e,n.multiple?s.multiple=!0:n.size&&(s.size=n.size))):e=s.createElementNS(e,t),e[Sa]=a,e[gr]=n,Lc(e,a,!1,!1),a.stateNode=e;e:{switch(s=Dl(t,n),t){case"dialog":ee("cancel",e),ee("close",e),r=n;break;case"iframe":case"object":case"embed":ee("load",e),r=n;break;case"video":case"audio":for(r=0;r<Qn.length;r++)ee(Qn[r],e);r=n;break;case"source":ee("error",e),r=n;break;case"img":case"image":case"link":ee("error",e),ee("load",e),r=n;break;case"details":ee("toggle",e),r=n;break;case"input":qi(e,n),r=Al(e,n),ee("invalid",e);break;case"option":r=n;break;case"select":e._wrapperState={wasMultiple:!!n.multiple},r=le({},n,{value:void 0}),ee("invalid",e);break;case"textarea":Vi(e,n),r=zl(e,n),ee("invalid",e);break;default:r=n}Fl(t,r),l=r;for(o in l)if(l.hasOwnProperty(o)){var u=l[o];o==="style"?Jd(e,u):o==="dangerouslySetInnerHTML"?(u=u?u.__html:void 0,u!=null&&Zd(e,u)):o==="children"?typeof u==="string"?(t!=="textarea"||u!=="")&&ur(e,u):typeof u==="number"&&ur(e,""+u):o!=="suppressContentEditableWarning"&&o!=="suppressHydrationWarning"&&o!=="autoFocus"&&(lr.hasOwnProperty(o)?u!=null&&o==="onScroll"&&ee("scroll",e):u!=null&&yu(e,o,u,s))}switch(t){case"input":go(e),Wi(e,n,!1);break;case"textarea":go(e),Gi(e);break;case"option":n.value!=null&&e.setAttribute("value",""+ot(n.value));break;case"select":e.multiple=!!n.multiple,o=n.value,o!=null?on(e,!!n.multiple,o,!1):n.defaultValue!=null&&on(e,!!n.multiple,n.defaultValue,!0);break;default:typeof r.onClick==="function"&&(e.onclick=$o)}switch(t){case"button":case"input":case"select":case"textarea":n=!!n.autoFocus;break e;case"img":n=!0;break e;default:n=!1}}n&&(a.flags|=4)}a.ref!==null&&(a.flags|=512,a.flags|=2097152)}return Te(a),null;case 6:if(e&&a.stateNode!=null)yc(e,a,e.memoizedProps,n);else{if(typeof n!=="string"&&a.stateNode===null)throw Error(C(166));if(t=Pt(Lr.current),Pt(ba.current),So(a)){if(n=a.stateNode,t=a.memoizedProps,n[Sa]=a,o=n.nodeValue!==t){if(e=Ge,e!==null)switch(e.tag){case 3:ko(n.nodeValue,t,(e.mode&1)!==0);break;case 5:e.memoizedProps.suppressHydrationWarning!==!0&&ko(n.nodeValue,t,(e.mode&1)!==0)}}o&&(a.flags|=4)}else n=(t.nodeType===9?t:t.ownerDocument).createTextNode(n),n[Sa]=a,a.stateNode=n}return Te(a),null;case 13:if(ae(oe),n=a.memoizedState,e===null||e.memoizedState!==null&&e.memoizedState.dehydrated!==null){if(te&&Ve!==null&&(a.mode&1)!==0&&(a.flags&128)===0)Nf(),mn(),a.flags|=98560,o=!1;else if(o=So(a),n!==null&&n.dehydrated!==null){if(e===null){if(!o)throw Error(C(318));if(o=a.memoizedState,o=o!==null?o.dehydrated:null,!o)throw Error(C(317));o[Sa]=a}else mn(),(a.flags&128)===0&&(a.memoizedState=null),a.flags|=4;Te(a),o=!1}else fa!==null&&(xu(fa),fa=null),o=!0;if(!o)return a.flags&65536?a:null}if((a.flags&128)!==0)return a.lanes=t,a;return n=n!==null,n!==(e!==null&&e.memoizedState!==null)&&n&&(a.child.flags|=8192,(a.mode&1)!==0&&(e===null||(oe.current&1)!==0?Le===0&&(Le=3):ni())),a.updateQueue!==null&&(a.flags|=4),Te(a),null;case 4:return gn(),iu(e,a),e===null&&Fu(a.stateNode.containerInfo),Te(a),null;case 10:return Hu(a.type._context),Te(a),null;case 17:return He(a.type)&&Qo(),Te(a),null;case 19:if(ae(oe),o=a.memoizedState,o===null)return Te(a),null;if(n=(a.flags&128)!==0,s=o.rendering,s===null)if(n)Un(o,!1);else{if(Le!==0||e!==null&&(e.flags&128)!==0)for(e=a.child;e!==null;){if(s=ns(e),s!==null){a.flags|=128,Un(o,!1),n=s.updateQueue,n!==null&&(a.updateQueue=n,a.flags|=4),a.subtreeFlags=0,n=t;for(t=a.child;t!==null;)o=t,e=n,o.flags&=14680066,s=o.alternate,s===null?(o.childLanes=0,o.lanes=e,o.child=null,o.subtreeFlags=0,o.memoizedProps=null,o.memoizedState=null,o.updateQueue=null,o.dependencies=null,o.stateNode=null):(o.childLanes=s.childLanes,o.lanes=s.lanes,o.child=s.child,o.subtreeFlags=0,o.deletions=null,o.memoizedProps=s.memoizedProps,o.memoizedState=s.memoizedState,o.updateQueue=s.updateQueue,o.type=s.type,e=s.dependencies,o.dependencies=e===null?null:{lanes:e.lanes,firstContext:e.firstContext}),t=t.sibling;return Q(oe,oe.current&1|2),a.child}e=e.sibling}o.tail!==null&&pe()>Ln&&(a.flags|=128,n=!0,Un(o,!1),a.lanes=4194304)}else{if(!n)if(e=ns(s),e!==null){if(a.flags|=128,n=!0,t=e.updateQueue,t!==null&&(a.updateQueue=t,a.flags|=4),Un(o,!0),o.tail===null&&o.tailMode==="hidden"&&!s.alternate&&!te)return Te(a),null}else 2*pe()-o.renderingStartTime>Ln&&t!==1073741824&&(a.flags|=128,n=!0,Un(o,!1),a.lanes=4194304);o.isBackwards?(s.sibling=a.child,a.child=s):(t=o.last,t!==null?t.sibling=s:a.child=s,o.last=s)}if(o.tail!==null)return a=o.tail,o.rendering=a,o.tail=a.sibling,o.renderingStartTime=pe(),a.sibling=null,t=oe.current,Q(oe,n?t&1|2:t&1),a;return Te(a),null;case 22:case 23:return ti(),n=a.memoizedState!==null,e!==null&&e.memoizedState!==null!==n&&(a.flags|=8192),n&&(a.mode&1)!==0?(We&1073741824)!==0&&(Te(a),a.subtreeFlags&6&&(a.flags|=8192)):Te(a),null;case 24:return null;case 25:return null}throw Error(C(156,a.tag))}function mh(e,a){switch(Eu(a),a.tag){case 1:return He(a.type)&&Qo(),e=a.flags,e&65536?(a.flags=e&-65537|128,a):null;case 3:return gn(),ae(Ue),ae(ze),ju(),e=a.flags,(e&65536)!==0&&(e&128)===0?(a.flags=e&-65537|128,a):null;case 5:return Gu(a),null;case 13:if(ae(oe),e=a.memoizedState,e!==null&&e.dehydrated!==null){if(a.alternate===null)throw Error(C(340));mn()}return e=a.flags,e&65536?(a.flags=e&-65537|128,a):null;case 19:return ae(oe),null;case 4:return gn(),null;case 10:return Hu(a.type._context),null;case 22:case 23:return ti(),null;case 24:return null;default:return null}}function nn(e,a){var t=e.ref;if(t!==null)if(typeof t==="function")try{t(null)}catch(n){de(e,a,n)}else t.current=null}function du(e,a,t){try{t()}catch(n){de(e,a,n)}}function gh(e,a){if(Kl=jo,e=Sf(),Ru(e)){if("selectionStart"in e)var t={start:e.selectionStart,end:e.selectionEnd};else e:{t=(t=e.ownerDocument)&&t.defaultView||window;var n=t.getSelection&&t.getSelection();if(n&&n.rangeCount!==0){t=n.anchorNode;var r=n.anchorOffset,o=n.focusNode;n=n.focusOffset;try{t.nodeType,o.nodeType}catch(w){t=null;break e}var s=0,l=-1,u=-1,c=0,m=0,g=e,h=null;a:for(;;){for(var x;;){if(g!==t||r!==0&&g.nodeType!==3||(l=s+r),g!==o||n!==0&&g.nodeType!==3||(u=s+n),g.nodeType===3&&(s+=g.nodeValue.length),(x=g.firstChild)===null)break;h=g,g=x}for(;;){if(g===e)break a;if(h===t&&++c===r&&(l=s),h===o&&++m===n&&(u=s),(x=g.nextSibling)!==null)break;g=h,h=g.parentNode}g=x}t=l===-1||u===-1?null:{start:l,end:u}}else t=null}t=t||{start:0,end:0}}else t=null;Xl={focusedElem:e,selectionRange:t},jo=!1;for(_=a;_!==null;)if(a=_,e=a.child,(a.subtreeFlags&1028)!==0&&e!==null)e.return=a,_=e;else for(;_!==null;){a=_;try{var v=a.alternate;if((a.flags&1024)!==0)switch(a.tag){case 0:case 11:case 15:break;case 1:if(v!==null){var k=v.memoizedProps,B=v.memoizedState,f=a.stateNode,d=f.getSnapshotBeforeUpdate(a.elementType===a.type?k:ia(a.type,k),B);f.__reactInternalSnapshotBeforeUpdate=d}break;case 3:var p=a.stateNode.containerInfo;p.nodeType===1?p.textContent="":p.nodeType===9&&p.documentElement&&p.removeChild(p.documentElement);break;case 5:case 6:case 4:case 17:break;default:throw Error(C(163))}}catch(w){de(a,a.return,w)}if(e=a.sibling,e!==null){e.return=a.return,_=e;break}_=a.return}return v=Rd,Rd=!1,v}function rr(e,a,t){var n=a.updateQueue;if(n=n!==null?n.lastEffect:null,n!==null){var r=n=n.next;do{if((r.tag&e)===e){var o=r.destroy;r.destroy=void 0,o!==void 0&&du(a,t,o)}r=r.next}while(r!==n)}}function Ls(e,a){if(a=a.updateQueue,a=a!==null?a.lastEffect:null,a!==null){var t=a=a.next;do{if((t.tag&e)===e){var n=t.create;t.destroy=n()}t=t.next}while(t!==a)}}function fu(e){var a=e.ref;if(a!==null){var t=e.stateNode;switch(e.tag){case 5:e=t;break;default:e=t}typeof a==="function"?a(e):a.current=e}}function vc(e){var a=e.alternate;a!==null&&(e.alternate=null,vc(a)),e.child=null,e.deletions=null,e.sibling=null,e.tag===5&&(a=e.stateNode,a!==null&&(delete a[Sa],delete a[gr],delete a[Zl],delete a[Y0],delete a[J0])),e.stateNode=null,e.return=null,e.dependencies=null,e.memoizedProps=null,e.memoizedState=null,e.pendingProps=null,e.stateNode=null,e.updateQueue=null}function Ic(e){return e.tag===5||e.tag===3||e.tag===4}function Fd(e){e:for(;;){for(;e.sibling===null;){if(e.return===null||Ic(e.return))return null;e=e.return}e.sibling.return=e.return;for(e=e.sibling;e.tag!==5&&e.tag!==6&&e.tag!==18;){if(e.flags&2)continue e;if(e.child===null||e.tag===4)continue e;else e.child.return=e,e=e.child}if(!(e.flags&2))return e.stateNode}}function cu(e,a,t){var n=e.tag;if(n===5||n===6)e=e.stateNode,a?t.nodeType===8?t.parentNode.insertBefore(e,a):t.insertBefore(e,a):(t.nodeType===8?(a=t.parentNode,a.insertBefore(e,t)):(a=t,a.appendChild(e)),t=t._reactRootContainer,t!==null&&t!==void 0||a.onclick!==null||(a.onclick=$o));else if(n!==4&&(e=e.child,e!==null))for(cu(e,a,t),e=e.sibling;e!==null;)cu(e,a,t),e=e.sibling}function pu(e,a,t){var n=e.tag;if(n===5||n===6)e=e.stateNode,a?t.insertBefore(e,a):t.appendChild(e);else if(n!==4&&(e=e.child,e!==null))for(pu(e,a,t),e=e.sibling;e!==null;)pu(e,a,t),e=e.sibling}function Va(e,a,t){for(t=t.child;t!==null;)Cc(e,a,t),t=t.sibling}function Cc(e,a,t){if(Pa&&typeof Pa.onCommitFiberUnmount==="function")try{Pa.onCommitFiberUnmount(ds,t)}catch(l){}switch(t.tag){case 5:_e||nn(t,a);case 6:var n=Se,r=da;Se=null,Va(e,a,t),Se=n,da=r,Se!==null&&(da?(e=Se,t=t.stateNode,e.nodeType===8?e.parentNode.removeChild(t):e.removeChild(t)):Se.removeChild(t.stateNode));break;case 18:Se!==null&&(da?(e=Se,t=t.stateNode,e.nodeType===8?ml(e.parentNode,t):e.nodeType===1&&ml(e,t),cr(e)):ml(Se,t.stateNode));break;case 4:n=Se,r=da,Se=t.stateNode.containerInfo,da=!0,Va(e,a,t),Se=n,da=r;break;case 0:case 11:case 14:case 15:if(!_e&&(n=t.updateQueue,n!==null&&(n=n.lastEffect,n!==null))){r=n=n.next;do{var o=r,s=o.destroy;o=o.tag,s!==void 0&&((o&2)!==0?du(t,a,s):(o&4)!==0&&du(t,a,s)),r=r.next}while(r!==n)}Va(e,a,t);break;case 1:if(!_e&&(nn(t,a),n=t.stateNode,typeof n.componentWillUnmount==="function"))try{n.props=t.memoizedProps,n.state=t.memoizedState,n.componentWillUnmount()}catch(l){de(t,a,l)}Va(e,a,t);break;case 21:Va(e,a,t);break;case 22:t.mode&1?(_e=(n=_e)||t.memoizedState!==null,Va(e,a,t),_e=n):Va(e,a,t);break;default:Va(e,a,t)}}function Dd(e){var a=e.updateQueue;if(a!==null){e.updateQueue=null;var t=e.stateNode;t===null&&(t=e.stateNode=new hh),a.forEach(function(n){var r=Ph.bind(null,e,n);t.has(n)||(t.add(n),n.then(r,r))})}}function ua(e,a){var t=a.deletions;if(t!==null)for(var n=0;n<t.length;n++){var r=t[n];try{var o=e,s=a,l=s;e:for(;l!==null;){switch(l.tag){case 5:Se=l.stateNode,da=!1;break e;case 3:Se=l.stateNode.containerInfo,da=!0;break e;case 4:Se=l.stateNode.containerInfo,da=!0;break e}l=l.return}if(Se===null)throw Error(C(160));Cc(o,s,r),Se=null,da=!1;var u=r.alternate;u!==null&&(u.return=null),r.return=null}catch(c){de(r,a,c)}}if(a.subtreeFlags&12854)for(a=a.child;a!==null;)kc(a,e),a=a.sibling}function kc(e,a){var{alternate:t,flags:n}=e;switch(e.tag){case 0:case 11:case 14:case 15:if(ua(a,e),Ca(e),n&4){try{rr(3,e,e.return),Ls(3,e)}catch(k){de(e,e.return,k)}try{rr(5,e,e.return)}catch(k){de(e,e.return,k)}}break;case 1:ua(a,e),Ca(e),n&512&&t!==null&&nn(t,t.return);break;case 5:if(ua(a,e),Ca(e),n&512&&t!==null&&nn(t,t.return),e.flags&32){var r=e.stateNode;try{ur(r,"")}catch(k){de(e,e.return,k)}}if(n&4&&(r=e.stateNode,r!=null)){var o=e.memoizedProps,s=t!==null?t.memoizedProps:o,{type:l,updateQueue:u}=e;if(e.updateQueue=null,u!==null)try{l==="input"&&o.type==="radio"&&o.name!=null&&Xd(r,o),Dl(l,s);var c=Dl(l,o);for(s=0;s<u.length;s+=2){var m=u[s],g=u[s+1];m==="style"?Jd(r,g):m==="dangerouslySetInnerHTML"?Zd(r,g):m==="children"?ur(r,g):yu(r,m,g,c)}switch(l){case"input":Tl(r,o);break;case"textarea":$d(r,o);break;case"select":var h=r._wrapperState.wasMultiple;r._wrapperState.wasMultiple=!!o.multiple;var x=o.value;x!=null?on(r,!!o.multiple,x,!1):h!==!!o.multiple&&(o.defaultValue!=null?on(r,!!o.multiple,o.defaultValue,!0):on(r,!!o.multiple,o.multiple?[]:"",!1))}r[gr]=o}catch(k){de(e,e.return,k)}}break;case 6:if(ua(a,e),Ca(e),n&4){if(e.stateNode===null)throw Error(C(162));r=e.stateNode,o=e.memoizedProps;try{r.nodeValue=o}catch(k){de(e,e.return,k)}}break;case 3:if(ua(a,e),Ca(e),n&4&&t!==null&&t.memoizedState.isDehydrated)try{cr(a.containerInfo)}catch(k){de(e,e.return,k)}break;case 4:ua(a,e),Ca(e);break;case 13:ua(a,e),Ca(e),r=e.child,r.flags&8192&&(o=r.memoizedState!==null,r.stateNode.isHidden=o,!o||r.alternate!==null&&r.alternate.memoizedState!==null||(ai=pe())),n&4&&Dd(e);break;case 22:if(m=t!==null&&t.memoizedState!==null,e.mode&1?(_e=(c=_e)||m,ua(a,e),_e=c):ua(a,e),Ca(e),n&8192){if(c=e.memoizedState!==null,(e.stateNode.isHidden=c)&&!m&&(e.mode&1)!==0)for(_=e,m=e.child;m!==null;){for(g=_=m;_!==null;){switch(h=_,x=h.child,h.tag){case 0:case 11:case 14:case 15:rr(4,h,h.return);break;case 1:nn(h,h.return);var v=h.stateNode;if(typeof v.componentWillUnmount==="function"){n=h,t=h.return;try{a=n,v.props=a.memoizedProps,v.state=a.memoizedState,v.componentWillUnmount()}catch(k){de(n,t,k)}}break;case 5:nn(h,h.return);break;case 22:if(h.memoizedState!==null){Ed(g);continue}}x!==null?(x.return=h,_=x):Ed(g)}m=m.sibling}e:for(m=null,g=e;;){if(g.tag===5){if(m===null){m=g;try{r=g.stateNode,c?(o=r.style,typeof o.setProperty==="function"?o.setProperty("display","none","important"):o.display="none"):(l=g.stateNode,u=g.memoizedProps.style,s=u!==void 0&&u!==null&&u.hasOwnProperty("display")?u.display:null,l.style.display=Yd("display",s))}catch(k){de(e,e.return,k)}}}else if(g.tag===6){if(m===null)try{g.stateNode.nodeValue=c?"":g.memoizedProps}catch(k){de(e,e.return,k)}}else if((g.tag!==22&&g.tag!==23||g.memoizedState===null||g===e)&&g.child!==null){g.child.return=g,g=g.child;continue}if(g===e)break e;for(;g.sibling===null;){if(g.return===null||g.return===e)break e;m===g&&(m=null),g=g.return}m===g&&(m=null),g.sibling.return=g.return,g=g.sibling}}break;case 19:ua(a,e),Ca(e),n&4&&Dd(e);break;case 21:break;default:ua(a,e),Ca(e)}}function Ca(e){var a=e.flags;if(a&2){try{e:{for(var t=e.return;t!==null;){if(Ic(t)){var n=t;break e}t=t.return}throw Error(C(160))}switch(n.tag){case 5:var r=n.stateNode;n.flags&32&&(ur(r,""),n.flags&=-33);var o=Fd(e);pu(e,o,r);break;case 3:case 4:var s=n.stateNode.containerInfo,l=Fd(e);cu(e,l,s);break;default:throw Error(C(161))}}catch(u){de(e,e.return,u)}e.flags&=-3}a&4096&&(e.flags&=-4097)}function xh(e,a,t){_=e,Sc(e,a,t)}function Sc(e,a,t){for(var n=(e.mode&1)!==0;_!==null;){var r=_,o=r.child;if(r.tag===22&&n){var s=r.memoizedState!==null||Mo;if(!s){var l=r.alternate,u=l!==null&&l.memoizedState!==null||_e;l=Mo;var c=_e;if(Mo=s,(_e=u)&&!c)for(_=r;_!==null;)s=_,u=s.child,s.tag===22&&s.memoizedState!==null?Nd(r):u!==null?(u.return=s,_=u):Nd(r);for(;o!==null;)_=o,Sc(o,a,t),o=o.sibling;_=r,Mo=l,_e=c}Bd(e,a,t)}else(r.subtreeFlags&8772)!==0&&o!==null?(o.return=r,_=o):Bd(e,a,t)}}function Bd(e){for(;_!==null;){var a=_;if((a.flags&8772)!==0){var t=a.alternate;try{if((a.flags&8772)!==0)switch(a.tag){case 0:case 11:case 15:_e||Ls(5,a);break;case 1:var n=a.stateNode;if(a.flags&4&&!_e)if(t===null)n.componentDidMount();else{var r=a.elementType===a.type?t.memoizedProps:ia(a.type,t.memoizedProps);n.componentDidUpdate(r,t.memoizedState,n.__reactInternalSnapshotBeforeUpdate)}var o=a.updateQueue;o!==null&&yd(a,o,n);break;case 3:var s=a.updateQueue;if(s!==null){if(t=null,a.child!==null)switch(a.child.tag){case 5:t=a.child.stateNode;break;case 1:t=a.child.stateNode}yd(a,s,t)}break;case 5:var l=a.stateNode;if(t===null&&a.flags&4){t=l;var u=a.memoizedProps;switch(a.type){case"button":case"input":case"select":case"textarea":u.autoFocus&&t.focus();break;case"img":u.src&&(t.src=u.src)}}break;case 6:break;case 4:break;case 12:break;case 13:if(a.memoizedState===null){var c=a.alternate;if(c!==null){var m=c.memoizedState;if(m!==null){var g=m.dehydrated;g!==null&&cr(g)}}}break;case 19:case 17:case 21:case 22:case 23:case 25:break;default:throw Error(C(163))}_e||a.flags&512&&fu(a)}catch(h){de(a,a.return,h)}}if(a===e){_=null;break}if(t=a.sibling,t!==null){t.return=a.return,_=t;break}_=a.return}}function Ed(e){for(;_!==null;){var a=_;if(a===e){_=null;break}var t=a.sibling;if(t!==null){t.return=a.return,_=t;break}_=a.return}}function Nd(e){for(;_!==null;){var a=_;try{switch(a.tag){case 0:case 11:case 15:var t=a.return;try{Ls(4,a)}catch(u){de(a,t,u)}break;case 1:var n=a.stateNode;if(typeof n.componentDidMount==="function"){var r=a.return;try{n.componentDidMount()}catch(u){de(a,r,u)}}var o=a.return;try{fu(a)}catch(u){de(a,o,u)}break;case 5:var s=a.return;try{fu(a)}catch(u){de(a,s,u)}}}catch(u){de(a,a.return,u)}if(a===e){_=null;break}var l=a.sibling;if(l!==null){l.return=a.return,_=l;break}_=a.return}}function De(){return(q&6)!==0?pe():No!==-1?No:No=pe()}function nt(e){if((e.mode&1)===0)return 1;if((q&2)!==0&&Pe!==0)return Pe&-Pe;if(ah.transition!==null)return Oo===0&&(Oo=uf()),Oo;if(e=j,e!==0)return e;return e=window.event,e=e===void 0?16:gf(e.type),e}function pa(e,a,t,n){if(50<sr)throw sr=0,hu=null,Error(C(185));if(Cr(e,t,n),(q&2)===0||e!==ve)e===ve&&((q&2)===0&&(ws|=t),Le===4&&Xa(e,Pe)),qe(e,n),t===1&&q===0&&(a.mode&1)===0&&(Ln=pe()+500,hs&&it())}function qe(e,a){var t=e.callbackNode;n0(e,a);var n=Go(e,e===ve?Pe:0);if(n===0)t!==null&&Xi(t),e.callbackNode=null,e.callbackPriority=0;else if(a=n&-n,e.callbackPriority!==a){if(t!=null&&Xi(t),a===1)e.tag===0?eh(Od.bind(null,e)):Df(Od.bind(null,e)),Q0(function(){(q&6)===0&&it()}),t=null;else{switch(df(n)){case 1:t=Su;break;case 4:t=sf;break;case 16:t=Vo;break;case 536870912:t=lf;break;default:t=Vo}t=Rc(t,Pc.bind(null,e))}e.callbackPriority=a,e.callbackNode=t}}function Pc(e,a){if(No=-1,Oo=0,(q&6)!==0)throw Error(C(327));var t=e.callbackNode;if(fn()&&e.callbackNode!==t)return null;var n=Go(e,e===ve?Pe:0);if(n===0)return null;if((n&30)!==0||(n&e.expiredLanes)!==0||a)a=is(e,n);else{a=n;var r=q;q|=2;var o=Mc();if(ve!==e||Pe!==a)_a=null,Ln=pe()+500,bt(e,a);do try{Ih();break}catch(l){bc(e,l)}while(1);Uu(),ss.current=o,q=r,he!==null?a=0:(ve=null,Pe=0,a=Le)}if(a!==0){if(a===2&&(r=Ul(e),r!==0&&(n=r,a=gu(e,r))),a===1)throw t=Ir,bt(e,0),Xa(e,n),qe(e,pe()),t;if(a===6)Xa(e,n);else{if(r=e.current.alternate,(n&30)===0&&!wh(r)&&(a=is(e,n),a===2&&(o=Ul(e),o!==0&&(n=o,a=gu(e,o))),a===1))throw t=Ir,bt(e,0),Xa(e,n),qe(e,pe()),t;switch(e.finishedWork=r,e.finishedLanes=n,a){case 0:case 1:throw Error(C(345));case 2:Ct(e,Ne,_a);break;case 3:if(Xa(e,n),(n&130023424)===n&&(a=ai+500-pe(),10<a)){if(Go(e,0)!==0)break;if(r=e.suspendedLanes,(r&n)!==n){De(),e.pingedLanes|=e.suspendedLanes&r;break}e.timeoutHandle=Ql(Ct.bind(null,e,Ne,_a),a);break}Ct(e,Ne,_a);break;case 4:if(Xa(e,n),(n&4194240)===n)break;a=e.eventTimes;for(r=-1;0<n;){var s=31-ca(n);o=1<<s,s=a[s],s>r&&(r=s),n&=~o}if(n=r,n=pe()-n,n=(120>n?120:480>n?480:1080>n?1080:1920>n?1920:3000>n?3000:4320>n?4320:1960*Lh(n/1960))-n,10<n){e.timeoutHandle=Ql(Ct.bind(null,e,Ne,_a),n);break}Ct(e,Ne,_a);break;case 5:Ct(e,Ne,_a);break;default:throw Error(C(329))}}}return qe(e,pe()),e.callbackNode===t?Pc.bind(null,e):null}function gu(e,a){var t=or;return e.current.memoizedState.isDehydrated&&(bt(e,a).flags|=256),e=is(e,a),e!==2&&(a=Ne,Ne=t,a!==null&&xu(a)),e}function xu(e){Ne===null?Ne=e:Ne.push.apply(Ne,e)}function wh(e){for(var a=e;;){if(a.flags&16384){var t=a.updateQueue;if(t!==null&&(t=t.stores,t!==null))for(var n=0;n<t.length;n++){var r=t[n],o=r.getSnapshot;r=r.value;try{if(!ma(o(),r))return!1}catch(s){return!1}}}if(t=a.child,a.subtreeFlags&16384&&t!==null)t.return=a,a=t;else{if(a===e)break;for(;a.sibling===null;){if(a.return===null||a.return===e)return!0;a=a.return}a.sibling.return=a.return,a=a.sibling}}return!0}function Xa(e,a){a&=~ei,a&=~ws,e.suspendedLanes|=a,e.pingedLanes&=~a;for(e=e.expirationTimes;0<a;){var t=31-ca(a),n=1<<t;e[t]=-1,a&=~n}}function Od(e){if((q&6)!==0)throw Error(C(327));fn();var a=Go(e,0);if((a&1)===0)return qe(e,pe()),null;var t=is(e,a);if(e.tag!==0&&t===2){var n=Ul(e);n!==0&&(a=n,t=gu(e,n))}if(t===1)throw t=Ir,bt(e,0),Xa(e,a),qe(e,pe()),t;if(t===6)throw Error(C(345));return e.finishedWork=e.current.alternate,e.finishedLanes=a,Ct(e,Ne,_a),qe(e,pe()),null}function yh(e,a){var t=q;q|=1;try{return e(a)}finally{q=t,q===0&&(Ln=pe()+500,hs&&it())}}function ys(e){Qa!==null&&Qa.tag===0&&(q&6)===0&&fn();var a=q;q|=1;var t=ea.transition,n=j;try{if(ea.transition=null,j=1,e)return e()}finally{j=n,ea.transition=t,q=a,(q&6)===0&&it()}}function ti(){We=rn.current,ae(rn)}function bt(e,a){e.finishedWork=null,e.finishedLanes=0;var t=e.timeoutHandle;if(t!==-1&&(e.timeoutHandle=-1,$0(t)),he!==null)for(t=he.return;t!==null;){var n=t;switch(Eu(n),n.tag){case 1:n=n.type.childContextTypes,n!==null&&n!==void 0&&Qo();break;case 3:gn(),ae(Ue),ae(ze),ju();break;case 5:Gu(n);break;case 4:gn();break;case 13:ae(oe);break;case 19:ae(oe);break;case 10:Hu(n.type._context);break;case 22:case 23:ti()}t=t.return}if(ve=e,he=e=rt(e.current,null),Pe=We=a,Le=0,Ir=null,ei=ws=zt=0,Ne=or=null,St!==null){for(a=0;a<St.length;a++)if(t=St[a],n=t.interleaved,n!==null){t.interleaved=null;var r=n.next,o=t.pending;if(o!==null){var s=o.next;o.next=r,n.next=s}t.pending=n}St=null}return e}function bc(e,a){do{var t=he;try{if(Uu(),Do.current=os,rs){for(var n=se.memoizedState;n!==null;){var r=n.queue;r!==null&&(r.pending=null),n=n.next}rs=!1}if(_t=0,ye=xe=se=null,nr=!1,wr=0,Ju.current=null,t===null||t.return===null){Le=1,Ir=a,he=null;break}e:{var o=e,s=t.return,l=t,u=a;if(a=Pe,l.flags|=32768,u!==null&&typeof u==="object"&&typeof u.then==="function"){var c=u,m=l,g=m.tag;if((m.mode&1)===0&&(g===0||g===11||g===15)){var h=m.alternate;h?(m.updateQueue=h.updateQueue,m.memoizedState=h.memoizedState,m.lanes=h.lanes):(m.updateQueue=null,m.memoizedState=null)}var x=Pd(s);if(x!==null){x.flags&=-257,bd(x,s,l,o,a),x.mode&1&&Sd(o,c,a),a=x,u=c;var v=a.updateQueue;if(v===null){var k=new Set;k.add(u),a.updateQueue=k}else v.add(u);break e}else{if((a&1)===0){Sd(o,c,a),ni();break e}u=Error(C(426))}}else if(te&&l.mode&1){var B=Pd(s);if(B!==null){(B.flags&65536)===0&&(B.flags|=256),bd(B,s,l,o,a),Nu(xn(u,l));break e}}o=u=xn(u,l),Le!==4&&(Le=2),or===null?or=[o]:or.push(o),o=s;do{switch(o.tag){case 3:o.flags|=65536,a&=-a,o.lanes|=a;var f=dc(o,u,a);wd(o,f);break e;case 1:l=u;var d=o.type,p=o.stateNode;if((o.flags&128)===0&&(typeof d.getDerivedStateFromError==="function"||p!==null&&typeof p.componentDidCatch==="function"&&(tt===null||!tt.has(p)))){o.flags|=65536,a&=-a,o.lanes|=a;var w=fc(o,l,a);wd(o,w);break e}}o=o.return}while(o!==null)}Tc(t)}catch(A){a=A,he===t&&t!==null&&(he=t=t.return);continue}break}while(1)}function Mc(){var e=ss.current;return ss.current=os,e===null?os:e}function ni(){if(Le===0||Le===3||Le===2)Le=4;ve===null||(zt&268435455)===0&&(ws&268435455)===0||Xa(ve,Pe)}function is(e,a){var t=q;q|=2;var n=Mc();if(ve!==e||Pe!==a)_a=null,bt(e,a);do try{vh();break}catch(r){bc(e,r)}while(1);if(Uu(),q=t,ss.current=n,he!==null)throw Error(C(261));return ve=null,Pe=0,Le}function vh(){for(;he!==null;)Ac(he)}function Ih(){for(;he!==null&&!Xm();)Ac(he)}function Ac(e){var a=zc(e.alternate,e,We);e.memoizedProps=e.pendingProps,a===null?Tc(e):he=a,Ju.current=null}function Tc(e){var a=e;do{var t=a.alternate;if(e=a.return,(a.flags&32768)===0){if(t=ph(t,a,We),t!==null){he=t;return}}else{if(t=mh(t,a),t!==null){t.flags&=32767,he=t;return}if(e!==null)e.flags|=32768,e.subtreeFlags=0,e.deletions=null;else{Le=6,he=null;return}}if(a=a.sibling,a!==null){he=a;return}he=a=e}while(a!==null);Le===0&&(Le=5)}function Ct(e,a,t){var n=j,r=ea.transition;try{ea.transition=null,j=1,Ch(e,a,t,n)}finally{ea.transition=r,j=n}return null}function Ch(e,a,t,n){do fn();while(Qa!==null);if((q&6)!==0)throw Error(C(327));t=e.finishedWork;var r=e.finishedLanes;if(t===null)return null;if(e.finishedWork=null,e.finishedLanes=0,t===e.current)throw Error(C(177));e.callbackNode=null,e.callbackPriority=0;var o=t.lanes|t.childLanes;if(r0(e,o),e===ve&&(he=ve=null,Pe=0),(t.subtreeFlags&2064)===0&&(t.flags&2064)===0||Ao||(Ao=!0,Rc(Vo,function(){return fn(),null})),o=(t.flags&15990)!==0,(t.subtreeFlags&15990)!==0||o){o=ea.transition,ea.transition=null;var s=j;j=1;var l=q;q|=4,Ju.current=null,gh(e,t),kc(t,e),V0(Xl),jo=!!Kl,Xl=Kl=null,e.current=t,xh(t,e,r),$m(),q=l,j=s,ea.transition=o}else e.current=t;if(Ao&&(Ao=!1,Qa=e,us=r),o=e.pendingLanes,o===0&&(tt=null),Ym(t.stateNode,n),qe(e,pe()),a!==null)for(n=e.onRecoverableError,t=0;t<a.length;t++)r=a[t],n(r.value,{componentStack:r.stack,digest:r.digest});if(ls)throw ls=!1,e=mu,mu=null,e;return(us&1)!==0&&e.tag!==0&&fn(),o=e.pendingLanes,(o&1)!==0?e===hu?sr++:(sr=0,hu=e):sr=0,it(),null}function fn(){if(Qa!==null){var e=df(us),a=ea.transition,t=j;try{if(ea.transition=null,j=16>e?16:e,Qa===null)var n=!1;else{if(e=Qa,Qa=null,us=0,(q&6)!==0)throw Error(C(331));var r=q;q|=4;for(_=e.current;_!==null;){var o=_,s=o.child;if((_.flags&16)!==0){var l=o.deletions;if(l!==null){for(var u=0;u<l.length;u++){var c=l[u];for(_=c;_!==null;){var m=_;switch(m.tag){case 0:case 11:case 15:rr(8,m,o)}var g=m.child;if(g!==null)g.return=m,_=g;else for(;_!==null;){m=_;var h=m.sibling,x=m.return;if(vc(m),m===c){_=null;break}if(h!==null){h.return=x,_=h;break}_=x}}}var v=o.alternate;if(v!==null){var k=v.child;if(k!==null){v.child=null;do{var B=k.sibling;k.sibling=null,k=B}while(k!==null)}}_=o}}if((o.subtreeFlags&2064)!==0&&s!==null)s.return=o,_=s;else e:for(;_!==null;){if(o=_,(o.flags&2048)!==0)switch(o.tag){case 0:case 11:case 15:rr(9,o,o.return)}var f=o.sibling;if(f!==null){f.return=o.return,_=f;break e}_=o.return}}var d=e.current;for(_=d;_!==null;){s=_;var p=s.child;if((s.subtreeFlags&2064)!==0&&p!==null)p.return=s,_=p;else e:for(s=d;_!==null;){if(l=_,(l.flags&2048)!==0)try{switch(l.tag){case 0:case 11:case 15:Ls(9,l)}}catch(A){de(l,l.return,A)}if(l===s){_=null;break e}var w=l.sibling;if(w!==null){w.return=l.return,_=w;break e}_=l.return}}if(q=r,it(),Pa&&typeof Pa.onPostCommitFiberRoot==="function")try{Pa.onPostCommitFiberRoot(ds,e)}catch(A){}n=!0}return n}finally{j=t,ea.transition=a}}return!1}function Ud(e,a,t){a=xn(t,a),a=dc(e,a,1),e=at(e,a,1),a=De(),e!==null&&(Cr(e,1,a),qe(e,a))}function de(e,a,t){if(e.tag===3)Ud(e,e,t);else for(;a!==null;){if(a.tag===3){Ud(a,e,t);break}else if(a.tag===1){var n=a.stateNode;if(typeof a.type.getDerivedStateFromError==="function"||typeof n.componentDidCatch==="function"&&(tt===null||!tt.has(n))){e=xn(t,e),e=fc(a,e,1),a=at(a,e,1),e=De(),a!==null&&(Cr(a,1,e),qe(a,e));break}}a=a.return}}function kh(e,a,t){var n=e.pingCache;n!==null&&n.delete(a),a=De(),e.pingedLanes|=e.suspendedLanes&t,ve===e&&(Pe&t)===t&&(Le===4||Le===3&&(Pe&130023424)===Pe&&500>pe()-ai?bt(e,0):ei|=t),qe(e,a)}function _c(e,a){a===0&&((e.mode&1)===0?a=1:(a=wo,wo<<=1,(wo&130023424)===0&&(wo=4194304)));var t=De();e=Ea(e,a),e!==null&&(Cr(e,a,t),qe(e,t))}function Sh(e){var a=e.memoizedState,t=0;a!==null&&(t=a.retryLane),_c(e,t)}function Ph(e,a){var t=0;switch(e.tag){case 13:var{stateNode:n,memoizedState:r}=e;r!==null&&(t=r.retryLane);break;case 19:n=e.stateNode;break;default:throw Error(C(314))}n!==null&&n.delete(a),_c(e,t)}function Rc(e,a){return of(e,a)}function bh(e,a,t,n){this.tag=e,this.key=t,this.sibling=this.child=this.return=this.stateNode=this.type=this.elementType=null,this.index=0,this.ref=null,this.pendingProps=a,this.dependencies=this.memoizedState=this.updateQueue=this.memoizedProps=null,this.mode=n,this.subtreeFlags=this.flags=0,this.deletions=null,this.childLanes=this.lanes=0,this.alternate=null}function Je(e,a,t,n){return new bh(e,a,t,n)}function ri(e){return e=e.prototype,!(!e||!e.isReactComponent)}function Mh(e){if(typeof e==="function")return ri(e)?1:0;if(e!==void 0&&e!==null){if(e=e.$$typeof,e===Iu)return 11;if(e===Cu)return 14}return 2}function rt(e,a){var t=e.alternate;return t===null?(t=Je(e.tag,a,e.key,e.mode),t.elementType=e.elementType,t.type=e.type,t.stateNode=e.stateNode,t.alternate=e,e.alternate=t):(t.pendingProps=a,t.type=e.type,t.flags=0,t.subtreeFlags=0,t.deletions=null),t.flags=e.flags&14680064,t.childLanes=e.childLanes,t.lanes=e.lanes,t.child=e.child,t.memoizedProps=e.memoizedProps,t.memoizedState=e.memoizedState,t.updateQueue=e.updateQueue,a=e.dependencies,t.dependencies=a===null?null:{lanes:a.lanes,firstContext:a.firstContext},t.sibling=e.sibling,t.index=e.index,t.ref=e.ref,t}function Uo(e,a,t,n,r,o){var s=2;if(n=e,typeof e==="function")ri(e)&&(s=1);else if(typeof e==="string")s=5;else e:switch(e){case $t:return Mt(t.children,r,o,a);case vu:s=8,r|=8;break;case Sl:return e=Je(12,t,a,r|2),e.elementType=Sl,e.lanes=o,e;case Pl:return e=Je(13,t,a,r),e.elementType=Pl,e.lanes=o,e;case bl:return e=Je(19,t,a,r),e.elementType=bl,e.lanes=o,e;case Gd:return vs(t,r,o,a);default:if(typeof e==="object"&&e!==null)switch(e.$$typeof){case Wd:s=10;break e;case Vd:s=9;break e;case Iu:s=11;break e;case Cu:s=14;break e;case Ga:s=16,n=null;break e}throw Error(C(130,e==null?e:typeof e,""))}return a=Je(s,t,a,r),a.elementType=e,a.type=n,a.lanes=o,a}function Mt(e,a,t,n){return e=Je(7,e,n,a),e.lanes=t,e}function vs(e,a,t,n){return e=Je(22,e,n,a),e.elementType=Gd,e.lanes=t,e.stateNode={isHidden:!1},e}function Il(e,a,t){return e=Je(6,e,null,a),e.lanes=t,e}function Cl(e,a,t){return a=Je(4,e.children!==null?e.children:[],e.key,a),a.lanes=t,a.stateNode={containerInfo:e.containerInfo,pendingChildren:null,implementation:e.implementation},a}function Ah(e,a,t,n,r){this.tag=a,this.containerInfo=e,this.finishedWork=this.pingCache=this.current=this.pendingChildren=null,this.timeoutHandle=-1,this.callbackNode=this.pendingContext=this.context=null,this.callbackPriority=0,this.eventTimes=ll(0),this.expirationTimes=ll(-1),this.entangledLanes=this.finishedLanes=this.mutableReadLanes=this.expiredLanes=this.pingedLanes=this.suspendedLanes=this.pendingLanes=0,this.entanglements=ll(0),this.identifierPrefix=n,this.onRecoverableError=r,this.mutableSourceEagerHydrationData=null}function Fc(e,a,t,n,r,o,s,l,u){return e=new Ah(e,a,t,l,u),a===1?(a=1,o===!0&&(a|=8)):a=0,o=Je(3,null,null,a),e.current=o,o.stateNode=e,o.memoizedState={element:n,isDehydrated:t,cache:null,transitions:null,pendingSuspenseBoundaries:null},Wu(o),e}function Dc(e){if(!e)return st;e=e._reactInternals;e:{if(Ft(e)!==e||e.tag!==1)throw Error(C(170));var a=e;do{switch(a.tag){case 3:a=a.stateNode.context;break e;case 1:if(He(a.type)){a=a.stateNode.__reactInternalMemoizedMergedChildContext;break e}}a=a.return}while(a!==null);throw Error(C(171))}if(e.tag===1){var t=e.type;if(He(t))return Ff(e,t,a)}return a}function Th(e,a,t,n,r,o,s,l,u){return e=Fc(t,n,!0,e,r,o,s,l,u),e.context=Dc(null),t=e.current,n=De(),r=nt(t),o=Da(n,r),o.callback=a!==void 0&&a!==null?a:null,at(t,o,r),e.current.lanes=r,Cr(e,r,n),qe(e,n),e}function Bc(e,a,t,n){var r=a.current,o=De(),s=nt(r);return t=Dc(t),a.context===null?a.context=t:a.pendingContext=t,a=Da(o,s),a.payload={element:e},n=n===void 0?null:n,n!==null&&(a.callback=n),e=at(r,a,s),e!==null&&(pa(e,r,s,o),Fo(e,r,s)),s}function Hd(e,a){if(e=e.memoizedState,e!==null&&e.dehydrated!==null){var t=e.retryLane;e.retryLane=t!==0&&t<a?t:a}}function oi(e,a){Hd(e,a),(e=e.alternate)&&Hd(e,a)}function _h(){return null}function si(e){this._internalRoot=e}function Is(e){this._internalRoot=e}function Nc(e){return!(!e||e.nodeType!==1&&e.nodeType!==9&&e.nodeType!==11)}var ne,qd,lr,Ba,kl,_m,Oi,Ui,be,Lu,Oa,ho,qn,$t,vu,Sl,Wd,Vd,Iu,Pl,bl,Cu,Ga,Gd,Hi,le,nl,rl=!1,Vn,xo,Zd,Yn,Nm,Om,Bl=null,El=null,sn=null,ln=null,sl=!1,Nl=!1,vt,Jn=!1,qo=null,Wo=!1,Ol=null,Wm,of,Xi,Xm,$m,pe,Qm,Su,sf,Vo,Zm,lf,ds=null,Pa=null,ca,Jm,e0,Lo=64,wo=4194304,j=0,ff,bu,cf,pf,mf,Hl=!1,yo,Za=null,Ya=null,Ja=null,dr,fr,Ka,o0,un,jo=!0,Ko=null,$a=null,Au=null,_o=null,wn,Tu,kr,d0,ul,il,Nn,fs,Yi,f0,c0,p0,dl,m0,h0,g0,x0,L0,Ji,w0,y0,v0,C0,k0,S0,ed,P0,b0,M0,A0,T0,_0,z0,zu,er=null,R0,Lf,ad,td=!1,Qt=!1,B0,ar=null,pr=null,If=!1,jn,Kn,Ro,ma,G0,Zt=null,Wl=null,tr=null,Vl=!1,Yt,fl,Pf,bf,Mf,Af,Tf,_f,ud,$n,Gl,jl,Xn,Qn,j0,Co,K0,X0,Kl=null,Xl=null,Ql,$0,cd,Q0,yn,Sa,gr,vn,Zl,Y0,J0,Yl,Jt=-1,st,ze,Ue,At,za=null,hs=!1,hl=!1,en,an=0,Yo=null,Jo=0,Ze,Ye=0,Tt=null,Ra=1,Fa="",Ge=null,Ve=null,te=!1,fa=null,ah,hn,Uf,es,as=null,tn=null,Ou=null,St=null,ja=!1,Sr,ba,xr,Lr,oe,gl,Do,xl,_t=0,se=null,xe=null,ye=null,rs=!1,nr=!1,wr=0,th=0,os,sh,lh,uh,xs,ih,dh,Oe=!1,lu,Lc,iu,wc,yc,Mo=!1,_e=!1,hh,_=null,Rd=!1,Se=null,da=!1,Lh,ss,Ju,ea,q=0,ve=null,he=null,Pe=0,We=0,rn,Le=0,Ir=null,zt=0,ws=0,ei=0,or=null,Ne=null,ai=0,Ln=1/0,_a=null,ls=!1,mu=null,tt=null,Ao=!1,Qa=null,us=0,sr=0,hu=null,No=-1,Oo=0,zc,Ec,Hn,zh,Xt,li=function(e,a){if(!Nc(e))throw Error(C(299));var t=!1,n="",r=Ec;return a!==null&&a!==void 0&&(a.unstable_strictMode===!0&&(t=!0),a.identifierPrefix!==void 0&&(n=a.identifierPrefix),a.onRecoverableError!==void 0&&(r=a.onRecoverableError)),a=Fc(e,1,!1,null,null,t,!1,n,r),e[vn]=a.current,Fu(e.nodeType===8?e.parentNode:e),new si(a)},Cs=function(e){return ys(e)},ui=function(e,a,t){if(!Nc(e))throw Error(C(405));var n=t!=null&&t.hydratedSources||null,r=!1,o="",s=Ec;if(t!==null&&t!==void 0&&(t.unstable_strictMode===!0&&(r=!0),t.identifierPrefix!==void 0&&(o=t.identifierPrefix),t.onRecoverableError!==void 0&&(s=t.onRecoverableError)),a=Th(a,null,e,1,t!=null?t:null,r,!1,o,s),e[vn]=a.current,Fu(e),n)for(e=0;e<n.length;e++)t=n[e],r=t._getVersion,r=r(t._source),a.mutableSourceEagerHydrationData==null?a.mutableSourceEagerHydrationData=[t,r]:a.mutableSourceEagerHydrationData.push(t,r);return new Is(a)};var Oc=Gs(()=>{va();ne=ki(Ni());qd=new Set,lr={};Ba=!(typeof window>"u"||typeof window.document>"u"||typeof window.document.createElement>"u"),kl=Object.prototype.hasOwnProperty,_m=/^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$/,Oi={},Ui={};be={};"children dangerouslySetInnerHTML defaultValue defaultChecked innerHTML suppressContentEditableWarning suppressHydrationWarning style".split(" ").forEach(function(e){be[e]=new Be(e,0,!1,e,null,!1,!1)});[["acceptCharset","accept-charset"],["className","class"],["htmlFor","for"],["httpEquiv","http-equiv"]].forEach(function(e){var a=e[0];be[a]=new Be(a,1,!1,e[1],null,!1,!1)});["contentEditable","draggable","spellCheck","value"].forEach(function(e){be[e]=new Be(e,2,!1,e.toLowerCase(),null,!1,!1)});["autoReverse","externalResourcesRequired","focusable","preserveAlpha"].forEach(function(e){be[e]=new Be(e,2,!1,e,null,!1,!1)});"allowFullScreen async autoFocus autoPlay controls default defer disabled disablePictureInPicture disableRemotePlayback formNoValidate hidden loop noModule noValidate open playsInline readOnly required reversed scoped seamless itemScope".split(" ").forEach(function(e){be[e]=new Be(e,3,!1,e.toLowerCase(),null,!1,!1)});["checked","multiple","muted","selected"].forEach(function(e){be[e]=new Be(e,3,!0,e,null,!1,!1)});["capture","download"].forEach(function(e){be[e]=new Be(e,4,!1,e,null,!1,!1)});["cols","rows","size","span"].forEach(function(e){be[e]=new Be(e,6,!1,e,null,!1,!1)});["rowSpan","start"].forEach(function(e){be[e]=new Be(e,5,!1,e.toLowerCase(),null,!1,!1)});Lu=/[\-:]([a-z])/g;"accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y word-spacing writing-mode xmlns:xlink x-height".split(" ").forEach(function(e){var a=e.replace(Lu,wu);be[a]=new Be(a,1,!1,e,null,!1,!1)});"xlink:actuate xlink:arcrole xlink:role xlink:show xlink:title xlink:type".split(" ").forEach(function(e){var a=e.replace(Lu,wu);be[a]=new Be(a,1,!1,e,"http://www.w3.org/1999/xlink",!1,!1)});["xml:base","xml:lang","xml:space"].forEach(function(e){var a=e.replace(Lu,wu);be[a]=new Be(a,1,!1,e,"http://www.w3.org/XML/1998/namespace",!1,!1)});["tabIndex","crossOrigin"].forEach(function(e){be[e]=new Be(e,1,!1,e.toLowerCase(),null,!1,!1)});be.xlinkHref=new Be("xlinkHref",1,!1,"xlink:href","http://www.w3.org/1999/xlink",!0,!1);["src","href","action","formAction"].forEach(function(e){be[e]=new Be(e,1,!1,e.toLowerCase(),null,!0,!0)});Oa=Mn,ho=Symbol.for("react.element"),qn=Symbol.for("react.portal"),$t=Symbol.for("react.fragment"),vu=Symbol.for("react.strict_mode"),Sl=Symbol.for("react.profiler"),Wd=Symbol.for("react.provider"),Vd=Symbol.for("react.context"),Iu=Symbol.for("react.forward_ref"),Pl=Symbol.for("react.suspense"),bl=Symbol.for("react.suspense_list"),Cu=Symbol.for("react.memo"),Ga=Symbol.for("react.lazy"),Gd=Symbol.for("react.offscreen"),Hi=Symbol.iterator;le=Object.assign;Vn=Array.isArray;Zd=function(e){return typeof MSApp<"u"&&MSApp.execUnsafeLocalFunction?function(a,t,n,r){MSApp.execUnsafeLocalFunction(function(){return e(a,t,n,r)})}:e}(function(e,a){if(e.namespaceURI!=="http://www.w3.org/2000/svg"||"innerHTML"in e)e.innerHTML=a;else{xo=xo||document.createElement("div"),xo.innerHTML="<svg>"+a.valueOf().toString()+"</svg>";for(a=xo.firstChild;e.firstChild;)e.removeChild(e.firstChild);for(;a.firstChild;)e.appendChild(a.firstChild)}});Yn={animationIterationCount:!0,aspectRatio:!0,borderImageOutset:!0,borderImageSlice:!0,borderImageWidth:!0,boxFlex:!0,boxFlexGroup:!0,boxOrdinalGroup:!0,columnCount:!0,columns:!0,flex:!0,flexGrow:!0,flexPositive:!0,flexShrink:!0,flexNegative:!0,flexOrder:!0,gridArea:!0,gridRow:!0,gridRowEnd:!0,gridRowSpan:!0,gridRowStart:!0,gridColumn:!0,gridColumnEnd:!0,gridColumnSpan:!0,gridColumnStart:!0,fontWeight:!0,lineClamp:!0,lineHeight:!0,opacity:!0,order:!0,orphans:!0,tabSize:!0,widows:!0,zIndex:!0,zoom:!0,fillOpacity:!0,floodOpacity:!0,stopOpacity:!0,strokeDasharray:!0,strokeDashoffset:!0,strokeMiterlimit:!0,strokeOpacity:!0,strokeWidth:!0},Nm=["Webkit","ms","Moz","O"];Object.keys(Yn).forEach(function(e){Nm.forEach(function(a){a=a+e.charAt(0).toUpperCase()+e.substring(1),Yn[a]=Yn[e]})});Om=le({menuitem:!0},{area:!0,base:!0,br:!0,col:!0,embed:!0,hr:!0,img:!0,input:!0,keygen:!0,link:!0,meta:!0,param:!0,source:!0,track:!0,wbr:!0});if(Ba)try{vt={},Object.defineProperty(vt,"passive",{get:function(){Nl=!0}}),window.addEventListener("test",vt,vt),window.removeEventListener("test",vt,vt)}catch(e){Nl=!1}Wm={onError:function(e){Jn=!0,qo=e}};of=ne.unstable_scheduleCallback,Xi=ne.unstable_cancelCallback,Xm=ne.unstable_shouldYield,$m=ne.unstable_requestPaint,pe=ne.unstable_now,Qm=ne.unstable_getCurrentPriorityLevel,Su=ne.unstable_ImmediatePriority,sf=ne.unstable_UserBlockingPriority,Vo=ne.unstable_NormalPriority,Zm=ne.unstable_LowPriority,lf=ne.unstable_IdlePriority;ca=Math.clz32?Math.clz32:a0,Jm=Math.log,e0=Math.LN2;yo=[],dr=new Map,fr=new Map,Ka=[],o0="mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset submit".split(" ");un=Oa.ReactCurrentBatchConfig;wn={eventPhase:0,bubbles:0,cancelable:0,timeStamp:function(e){return e.timeStamp||Date.now()},defaultPrevented:0,isTrusted:0},Tu=je(wn),kr=le({},wn,{view:0,detail:0}),d0=je(kr),fs=le({},kr,{screenX:0,screenY:0,clientX:0,clientY:0,pageX:0,pageY:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,getModifierState:_u,button:0,buttons:0,relatedTarget:function(e){return e.relatedTarget===void 0?e.fromElement===e.srcElement?e.toElement:e.fromElement:e.relatedTarget},movementX:function(e){if("movementX"in e)return e.movementX;return e!==Nn&&(Nn&&e.type==="mousemove"?(ul=e.screenX-Nn.screenX,il=e.screenY-Nn.screenY):il=ul=0,Nn=e),ul},movementY:function(e){return"movementY"in e?e.movementY:il}}),Yi=je(fs),f0=le({},fs,{dataTransfer:0}),c0=je(f0),p0=le({},kr,{relatedTarget:0}),dl=je(p0),m0=le({},wn,{animationName:0,elapsedTime:0,pseudoElement:0}),h0=je(m0),g0=le({},wn,{clipboardData:function(e){return"clipboardData"in e?e.clipboardData:window.clipboardData}}),x0=je(g0),L0=le({},wn,{data:0}),Ji=je(L0),w0={Esc:"Escape",Spacebar:" ",Left:"ArrowLeft",Up:"ArrowUp",Right:"ArrowRight",Down:"ArrowDown",Del:"Delete",Win:"OS",Menu:"ContextMenu",Apps:"ContextMenu",Scroll:"ScrollLock",MozPrintableKey:"Unidentified"},y0={8:"Backspace",9:"Tab",12:"Clear",13:"Enter",16:"Shift",17:"Control",18:"Alt",19:"Pause",20:"CapsLock",27:"Escape",32:" ",33:"PageUp",34:"PageDown",35:"End",36:"Home",37:"ArrowLeft",38:"ArrowUp",39:"ArrowRight",40:"ArrowDown",45:"Insert",46:"Delete",112:"F1",113:"F2",114:"F3",115:"F4",116:"F5",117:"F6",118:"F7",119:"F8",120:"F9",121:"F10",122:"F11",123:"F12",144:"NumLock",145:"ScrollLock",224:"Meta"},v0={Alt:"altKey",Control:"ctrlKey",Meta:"metaKey",Shift:"shiftKey"};C0=le({},kr,{key:function(e){if(e.key){var a=w0[e.key]||e.key;if(a!=="Unidentified")return a}return e.type==="keypress"?(e=zo(e),e===13?"Enter":String.fromCharCode(e)):e.type==="keydown"||e.type==="keyup"?y0[e.keyCode]||"Unidentified":""},code:0,location:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,repeat:0,locale:0,getModifierState:_u,charCode:function(e){return e.type==="keypress"?zo(e):0},keyCode:function(e){return e.type==="keydown"||e.type==="keyup"?e.keyCode:0},which:function(e){return e.type==="keypress"?zo(e):e.type==="keydown"||e.type==="keyup"?e.keyCode:0}}),k0=je(C0),S0=le({},fs,{pointerId:0,width:0,height:0,pressure:0,tangentialPressure:0,tiltX:0,tiltY:0,twist:0,pointerType:0,isPrimary:0}),ed=je(S0),P0=le({},kr,{touches:0,targetTouches:0,changedTouches:0,altKey:0,metaKey:0,ctrlKey:0,shiftKey:0,getModifierState:_u}),b0=je(P0),M0=le({},wn,{propertyName:0,elapsedTime:0,pseudoElement:0}),A0=je(M0),T0=le({},fs,{deltaX:function(e){return"deltaX"in e?e.deltaX:("wheelDeltaX"in e)?-e.wheelDeltaX:0},deltaY:function(e){return"deltaY"in e?e.deltaY:("wheelDeltaY"in e)?-e.wheelDeltaY:("wheelDelta"in e)?-e.wheelDelta:0},deltaZ:0,deltaMode:0}),_0=je(T0),z0=[9,13,27,32],zu=Ba&&"CompositionEvent"in window;Ba&&"documentMode"in document&&(er=document.documentMode);R0=Ba&&"TextEvent"in window&&!er,Lf=Ba&&(!zu||er&&8<er&&11>=er),ad=String.fromCharCode(32);B0={color:!0,date:!0,datetime:!0,"datetime-local":!0,email:!0,month:!0,number:!0,password:!0,range:!0,search:!0,tel:!0,text:!0,time:!0,url:!0,week:!0};if(Ba){if(Ba){if(Kn="oninput"in document,!Kn)Ro=document.createElement("div"),Ro.setAttribute("oninput","return;"),Kn=typeof Ro.oninput==="function";jn=Kn}else jn=!1;If=jn&&(!document.documentMode||9<document.documentMode)}ma=typeof Object.is==="function"?Object.is:W0;G0=Ba&&"documentMode"in document&&11>=document.documentMode;Yt={animationend:Io("Animation","AnimationEnd"),animationiteration:Io("Animation","AnimationIteration"),animationstart:Io("Animation","AnimationStart"),transitionend:Io("Transition","TransitionEnd")},fl={},Pf={};Ba&&(Pf=document.createElement("div").style,("AnimationEvent"in window)||(delete Yt.animationend.animation,delete Yt.animationiteration.animation,delete Yt.animationstart.animation),("TransitionEvent"in window)||delete Yt.transitionend.transition);bf=ps("animationend"),Mf=ps("animationiteration"),Af=ps("animationstart"),Tf=ps("transitionend"),_f=new Map,ud="abort auxClick cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");for(Xn=0;Xn<ud.length;Xn++)$n=ud[Xn],Gl=$n.toLowerCase(),jl=$n[0].toUpperCase()+$n.slice(1),lt(Gl,"on"+jl);lt(bf,"onAnimationEnd");lt(Mf,"onAnimationIteration");lt(Af,"onAnimationStart");lt("dblclick","onDoubleClick");lt("focusin","onFocus");lt("focusout","onBlur");lt(Tf,"onTransitionEnd");cn("onMouseEnter",["mouseout","mouseover"]);cn("onMouseLeave",["mouseout","mouseover"]);cn("onPointerEnter",["pointerout","pointerover"]);cn("onPointerLeave",["pointerout","pointerover"]);Rt("onChange","change click focusin focusout input keydown keyup selectionchange".split(" "));Rt("onSelect","focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" "));Rt("onBeforeInput",["compositionend","keypress","textInput","paste"]);Rt("onCompositionEnd","compositionend focusout keydown keypress keyup mousedown".split(" "));Rt("onCompositionStart","compositionstart focusout keydown keypress keyup mousedown".split(" "));Rt("onCompositionUpdate","compositionupdate focusout keydown keypress keyup mousedown".split(" "));Qn="abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" "),j0=new Set("cancel close invalid load scroll toggle".split(" ").concat(Qn));Co="_reactListening"+Math.random().toString(36).slice(2);K0=/\r\n?/g,X0=/\u0000|\uFFFD/g;Ql=typeof setTimeout==="function"?setTimeout:void 0,$0=typeof clearTimeout==="function"?clearTimeout:void 0,cd=typeof Promise==="function"?Promise:void 0,Q0=typeof queueMicrotask==="function"?queueMicrotask:typeof cd<"u"?function(e){return cd.resolve(null).then(e).catch(Z0)}:Ql;yn=Math.random().toString(36).slice(2),Sa="__reactFiber$"+yn,gr="__reactProps$"+yn,vn="__reactContainer$"+yn,Zl="__reactEvents$"+yn,Y0="__reactListeners$"+yn,J0="__reactHandles$"+yn;Yl=[];st={},ze=ut(st),Ue=ut(!1),At=st;en=[],Ze=[];ah=Oa.ReactCurrentBatchConfig;hn=Of(!0),Uf=Of(!1),es=ut(null);Sr={},ba=ut(Sr),xr=ut(Sr),Lr=ut(Sr);oe=ut(0);gl=[];Do=Oa.ReactCurrentDispatcher,xl=Oa.ReactCurrentBatchConfig;os={readContext:aa,useCallback:Ae,useContext:Ae,useEffect:Ae,useImperativeHandle:Ae,useInsertionEffect:Ae,useLayoutEffect:Ae,useMemo:Ae,useReducer:Ae,useRef:Ae,useState:Ae,useDebugValue:Ae,useDeferredValue:Ae,useTransition:Ae,useMutableSource:Ae,useSyncExternalStore:Ae,useId:Ae,unstable_isNewReconciler:!1},sh={readContext:aa,useCallback:function(e,a){return ka().memoizedState=[e,a===void 0?null:a],e},useContext:aa,useEffect:Id,useImperativeHandle:function(e,a,t){return t=t!==null&&t!==void 0?t.concat([e]):null,Bo(4194308,4,ec.bind(null,a,e),t)},useLayoutEffect:function(e,a){return Bo(4194308,4,e,a)},useInsertionEffect:function(e,a){return Bo(4,2,e,a)},useMemo:function(e,a){var t=ka();return a=a===void 0?null:a,e=e(),t.memoizedState=[e,a],e},useReducer:function(e,a,t){var n=ka();return a=t!==void 0?t(a):a,n.memoizedState=n.baseState=a,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:e,lastRenderedState:a},n.queue=e,e=e.dispatch=rh.bind(null,se,e),[n.memoizedState,e]},useRef:function(e){var a=ka();return e={current:e},a.memoizedState=e},useState:vd,useDebugValue:Zu,useDeferredValue:function(e){return ka().memoizedState=e},useTransition:function(){var e=vd(!1),a=e[0];return e=nh.bind(null,e[1]),ka().memoizedState=e,[a,e]},useMutableSource:function(){},useSyncExternalStore:function(e,a,t){var n=se,r=ka();if(te){if(t===void 0)throw Error(C(407));t=t()}else{if(t=a(),ve===null)throw Error(C(349));(_t&30)!==0||jf(n,a,t)}r.memoizedState=t;var o={value:t,getSnapshot:a};return r.queue=o,Id(Xf.bind(null,n,o,e),[e]),n.flags|=2048,vr(9,Kf.bind(null,n,o,t,a),void 0,null),t},useId:function(){var e=ka(),a=ve.identifierPrefix;if(te){var t=Fa,n=Ra;t=(n&~(1<<32-ca(n)-1)).toString(32)+t,a=":"+a+"R"+t,t=wr++,0<t&&(a+="H"+t.toString(32)),a+=":"}else t=th++,a=":"+a+"r"+t.toString(32)+":";return e.memoizedState=a},unstable_isNewReconciler:!1},lh={readContext:aa,useCallback:tc,useContext:aa,useEffect:Qu,useImperativeHandle:ac,useInsertionEffect:Yf,useLayoutEffect:Jf,useMemo:nc,useReducer:Ll,useRef:Zf,useState:function(){return Ll(yr)},useDebugValue:Zu,useDeferredValue:function(e){var a=ta();return rc(a,xe.memoizedState,e)},useTransition:function(){var e=Ll(yr)[0],a=ta().memoizedState;return[e,a]},useMutableSource:Vf,useSyncExternalStore:Gf,useId:oc,unstable_isNewReconciler:!1},uh={readContext:aa,useCallback:tc,useContext:aa,useEffect:Qu,useImperativeHandle:ac,useInsertionEffect:Yf,useLayoutEffect:Jf,useMemo:nc,useReducer:wl,useRef:Zf,useState:function(){return wl(yr)},useDebugValue:Zu,useDeferredValue:function(e){var a=ta();return xe===null?a.memoizedState=e:rc(a,xe.memoizedState,e)},useTransition:function(){var e=wl(yr)[0],a=ta().memoizedState;return[e,a]},useMutableSource:Vf,useSyncExternalStore:Gf,useId:oc,unstable_isNewReconciler:!1};xs={isMounted:function(e){return(e=e._reactInternals)?Ft(e)===e:!1},enqueueSetState:function(e,a,t){e=e._reactInternals;var n=De(),r=nt(e),o=Da(n,r);o.payload=a,t!==void 0&&t!==null&&(o.callback=t),a=at(e,o,r),a!==null&&(pa(a,e,r,n),Fo(a,e,r))},enqueueReplaceState:function(e,a,t){e=e._reactInternals;var n=De(),r=nt(e),o=Da(n,r);o.tag=1,o.payload=a,t!==void 0&&t!==null&&(o.callback=t),a=at(e,o,r),a!==null&&(pa(a,e,r,n),Fo(a,e,r))},enqueueForceUpdate:function(e,a){e=e._reactInternals;var t=De(),n=nt(e),r=Da(t,n);r.tag=2,a!==void 0&&a!==null&&(r.callback=a),a=at(e,r,n),a!==null&&(pa(a,e,n,t),Fo(a,e,n))}};ih=typeof WeakMap==="function"?WeakMap:Map;dh=Oa.ReactCurrentOwner;lu={dehydrated:null,treeContext:null,retryLane:0};Lc=function(e,a){for(var t=a.child;t!==null;){if(t.tag===5||t.tag===6)e.appendChild(t.stateNode);else if(t.tag!==4&&t.child!==null){t.child.return=t,t=t.child;continue}if(t===a)break;for(;t.sibling===null;){if(t.return===null||t.return===a)return;t=t.return}t.sibling.return=t.return,t=t.sibling}};iu=function(){};wc=function(e,a,t,n){var r=e.memoizedProps;if(r!==n){e=a.stateNode,Pt(ba.current);var o=null;switch(t){case"input":r=Al(e,r),n=Al(e,n),o=[];break;case"select":r=le({},r,{value:void 0}),n=le({},n,{value:void 0}),o=[];break;case"textarea":r=zl(e,r),n=zl(e,n),o=[];break;default:typeof r.onClick!=="function"&&typeof n.onClick==="function"&&(e.onclick=$o)}Fl(t,n);var s;t=null;for(c in r)if(!n.hasOwnProperty(c)&&r.hasOwnProperty(c)&&r[c]!=null)if(c==="style"){var l=r[c];for(s in l)l.hasOwnProperty(s)&&(t||(t={}),t[s]="")}else c!=="dangerouslySetInnerHTML"&&c!=="children"&&c!=="suppressContentEditableWarning"&&c!=="suppressHydrationWarning"&&c!=="autoFocus"&&(lr.hasOwnProperty(c)?o||(o=[]):(o=o||[]).push(c,null));for(c in n){var u=n[c];if(l=r!=null?r[c]:void 0,n.hasOwnProperty(c)&&u!==l&&(u!=null||l!=null))if(c==="style")if(l){for(s in l)!l.hasOwnProperty(s)||u&&u.hasOwnProperty(s)||(t||(t={}),t[s]="");for(s in u)u.hasOwnProperty(s)&&l[s]!==u[s]&&(t||(t={}),t[s]=u[s])}else t||(o||(o=[]),o.push(c,t)),t=u;else c==="dangerouslySetInnerHTML"?(u=u?u.__html:void 0,l=l?l.__html:void 0,u!=null&&l!==u&&(o=o||[]).push(c,u)):c==="children"?typeof u!=="string"&&typeof u!=="number"||(o=o||[]).push(c,""+u):c!=="suppressContentEditableWarning"&&c!=="suppressHydrationWarning"&&(lr.hasOwnProperty(c)?(u!=null&&c==="onScroll"&&ee("scroll",e),o||l===u||(o=[])):(o=o||[]).push(c,u))}t&&(o=o||[]).push("style",t);var c=o;if(a.updateQueue=c)a.flags|=4}};yc=function(e,a,t,n){t!==n&&(a.flags|=4)};hh=typeof WeakSet==="function"?WeakSet:Set;Lh=Math.ceil,ss=Oa.ReactCurrentDispatcher,Ju=Oa.ReactCurrentOwner,ea=Oa.ReactCurrentBatchConfig,rn=ut(0);zc=function(e,a,t){if(e!==null)if(e.memoizedProps!==a.pendingProps||Ue.current)Oe=!0;else{if((e.lanes&t)===0&&(a.flags&128)===0)return Oe=!1,ch(e,a,t);Oe=(e.flags&131072)!==0?!0:!1}else Oe=!1,te&&(a.flags&1048576)!==0&&Bf(a,Jo,a.index);switch(a.lanes=0,a.tag){case 2:var n=a.type;Eo(e,a),e=a.pendingProps;var r=pn(a,ze.current);dn(a,t),r=Xu(null,a,n,e,r,t);var o=$u();return a.flags|=1,typeof r==="object"&&r!==null&&typeof r.render==="function"&&r.$$typeof===void 0?(a.tag=1,a.memoizedState=null,a.updateQueue=null,He(n)?(o=!0,Zo(a)):o=!1,a.memoizedState=r.state!==null&&r.state!==void 0?r.state:null,Wu(a),r.updater=xs,a.stateNode=r,r._reactInternals=a,nu(a,n,e,t),a=su(null,a,n,!0,o,t)):(a.tag=0,te&&o&&Bu(a),Fe(null,a,r,t),a=a.child),a;case 16:n=a.elementType;e:{switch(Eo(e,a),e=a.pendingProps,r=n._init,n=r(n._payload),a.type=n,r=a.tag=Mh(n),e=ia(n,e),r){case 0:a=ou(null,a,n,e,t);break e;case 1:a=Td(null,a,n,e,t);break e;case 11:a=Md(null,a,n,e,t);break e;case 14:a=Ad(null,a,n,ia(n.type,e),t);break e}throw Error(C(306,n,""))}return a;case 0:return n=a.type,r=a.pendingProps,r=a.elementType===n?r:ia(n,r),ou(e,a,n,r,t);case 1:return n=a.type,r=a.pendingProps,r=a.elementType===n?r:ia(n,r),Td(e,a,n,r,t);case 3:e:{if(hc(a),e===null)throw Error(C(387));n=a.pendingProps,o=a.memoizedState,r=o.element,qf(e,a),ts(a,n,null,t);var s=a.memoizedState;if(n=s.element,o.isDehydrated)if(o={element:n,isDehydrated:!1,cache:s.cache,pendingSuspenseBoundaries:s.pendingSuspenseBoundaries,transitions:s.transitions},a.updateQueue.baseState=o,a.memoizedState=o,a.flags&256){r=xn(Error(C(423)),a),a=_d(e,a,n,t,r);break e}else if(n!==r){r=xn(Error(C(424)),a),a=_d(e,a,n,t,r);break e}else for(Ve=et(a.stateNode.containerInfo.firstChild),Ge=a,te=!0,fa=null,t=Uf(a,null,n,t),a.child=t;t;)t.flags=t.flags&-3|4096,t=t.sibling;else{if(mn(),n===r){a=Na(e,a,t);break e}Fe(e,a,n,t)}a=a.child}return a;case 5:return Wf(a),e===null&&eu(a),n=a.type,r=a.pendingProps,o=e!==null?e.memoizedProps:null,s=r.children,$l(n,r)?s=null:o!==null&&$l(n,o)&&(a.flags|=32),mc(e,a),Fe(e,a,s,t),a.child;case 6:return e===null&&eu(a),null;case 13:return gc(e,a,t);case 4:return Vu(a,a.stateNode.containerInfo),n=a.pendingProps,e===null?a.child=hn(a,null,n,t):Fe(e,a,n,t),a.child;case 11:return n=a.type,r=a.pendingProps,r=a.elementType===n?r:ia(n,r),Md(e,a,n,r,t);case 7:return Fe(e,a,a.pendingProps,t),a.child;case 8:return Fe(e,a,a.pendingProps.children,t),a.child;case 12:return Fe(e,a,a.pendingProps.children,t),a.child;case 10:e:{if(n=a.type._context,r=a.pendingProps,o=a.memoizedProps,s=r.value,Q(es,n._currentValue),n._currentValue=s,o!==null)if(ma(o.value,s)){if(o.children===r.children&&!Ue.current){a=Na(e,a,t);break e}}else for(o=a.child,o!==null&&(o.return=a);o!==null;){var l=o.dependencies;if(l!==null){s=o.child;for(var u=l.firstContext;u!==null;){if(u.context===n){if(o.tag===1){u=Da(-1,t&-t),u.tag=2;var c=o.updateQueue;if(c!==null){c=c.shared;var m=c.pending;m===null?u.next=u:(u.next=m.next,m.next=u),c.pending=u}}o.lanes|=t,u=o.alternate,u!==null&&(u.lanes|=t),au(o.return,t,a),l.lanes|=t;break}u=u.next}}else if(o.tag===10)s=o.type===a.type?null:o.child;else if(o.tag===18){if(s=o.return,s===null)throw Error(C(341));s.lanes|=t,l=s.alternate,l!==null&&(l.lanes|=t),au(s,t,a),s=o.sibling}else s=o.child;if(s!==null)s.return=o;else for(s=o;s!==null;){if(s===a){s=null;break}if(o=s.sibling,o!==null){o.return=s.return,s=o;break}s=s.return}o=s}Fe(e,a,r.children,t),a=a.child}return a;case 9:return r=a.type,n=a.pendingProps.children,dn(a,t),r=aa(r),n=n(r),a.flags|=1,Fe(e,a,n,t),a.child;case 14:return n=a.type,r=ia(n,a.pendingProps),r=ia(n.type,r),Ad(e,a,n,r,t);case 15:return cc(e,a,a.type,a.pendingProps,t);case 17:return n=a.type,r=a.pendingProps,r=a.elementType===n?r:ia(n,r),Eo(e,a),a.tag=1,He(n)?(e=!0,Zo(a)):e=!1,dn(a,t),ic(a,n,r),nu(a,n,r,t),su(null,a,n,!0,e,t);case 19:return xc(e,a,t);case 22:return pc(e,a,t)}throw Error(C(156,a.tag))};Ec=typeof reportError==="function"?reportError:function(e){console.error(e)};Is.prototype.render=si.prototype.render=function(e){var a=this._internalRoot;if(a===null)throw Error(C(409));Bc(e,a,null,null)};Is.prototype.unmount=si.prototype.unmount=function(){var e=this._internalRoot;if(e!==null){this._internalRoot=null;var a=e.containerInfo;ys(function(){Bc(null,e,null,null)}),a[vn]=null}};Is.prototype.unstable_scheduleHydration=function(e){if(e){var a=pf();e={blockedOn:null,target:e,priority:a};for(var t=0;t<Ka.length&&a!==0&&a<Ka[t].priority;t++);Ka.splice(t,0,e),t===0&&hf(e)}};ff=function(e){switch(e.tag){case 3:var a=e.stateNode;if(a.current.memoizedState.isDehydrated){var t=Gn(a.pendingLanes);t!==0&&(Pu(a,t|1),qe(a,pe()),(q&6)===0&&(Ln=pe()+500,it()))}break;case 13:ys(function(){var n=Ea(e,1);if(n!==null){var r=De();pa(n,e,1,r)}}),oi(e,1)}};bu=function(e){if(e.tag===13){var a=Ea(e,134217728);if(a!==null){var t=De();pa(a,e,134217728,t)}oi(e,134217728)}};cf=function(e){if(e.tag===13){var a=nt(e),t=Ea(e,a);if(t!==null){var n=De();pa(t,e,a,n)}oi(e,a)}};pf=function(){return j};mf=function(e,a){var t=j;try{return j=e,a()}finally{j=t}};El=function(e,a,t){switch(a){case"input":if(Tl(e,t),a=t.name,t.type==="radio"&&a!=null){for(t=e;t.parentNode;)t=t.parentNode;t=t.querySelectorAll("input[name="+JSON.stringify(""+a)+'][type="radio"]');for(a=0;a<t.length;a++){var n=t[a];if(n!==e&&n.form===e.form){var r=Du(n);if(!r)throw Error(C(90));Kd(n),Tl(n,r)}}}break;case"textarea":$d(e,t);break;case"select":a=t.value,a!=null&&on(e,!!t.multiple,a,!1)}};ef=yh;af=ys;Hn={findFiberByHostInstance:kt,bundleType:0,version:"18.3.1",rendererPackageName:"react-dom"},zh={bundleType:Hn.bundleType,version:Hn.version,rendererPackageName:Hn.rendererPackageName,rendererConfig:Hn.rendererConfig,overrideHookState:null,overrideHookStateDeletePath:null,overrideHookStateRenamePath:null,overrideProps:null,overridePropsDeletePath:null,overridePropsRenamePath:null,setErrorHandler:null,setSuspenseHandler:null,scheduleUpdate:null,currentDispatcherRef:Oa.ReactCurrentDispatcher,findHostInstanceByFiber:function(e){return e=Km(e),e===null?null:e.stateNode},findFiberByHostInstance:Hn.findFiberByHostInstance||_h,findHostInstancesForRefresh:null,scheduleRefresh:null,scheduleRoot:null,setRefreshHandler:null,getCurrentFiber:null,reconcilerVersion:"18.3.1-next-f1338f8080-20240426"};if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__<"u"){if(Xt=__REACT_DEVTOOLS_GLOBAL_HOOK__,!Xt.isDisabled&&Xt.supportsFiber)try{ds=Xt.inject(zh),Pa=Xt}catch(e){}}});function Uc(){if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__>"u"||typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE!=="function")return;try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(Uc)}catch(e){console.error(e)}}var ii=Gs(()=>{Oc();Uc()});var Hc=Si(function(Dh){ii();Dh.createRoot=li,Dh.hydrateRoot=ui;var Fh});var Hp=ki(Hc(),1);var qc=document.createElement("style");qc.textContent=`/* The dotz look: the site's own tokens (style.css :root, light and dark)
   mapped onto the kit's. Unlayered, so it wins over the kit's @layer. */
.dz .ss-stage {
  --ss-canvas: var(--bg);
  --ss-surface: var(--surface);
  --ss-chrome: var(--surface);
  --ss-raised: var(--surface);
  --ss-well: var(--surface-2);
  --ss-line: var(--line);
  --ss-line-strong: var(--line-strong);
  --ss-line-faint: color-mix(in srgb, var(--line) 60%, transparent);
  --ss-text-strong: var(--ink);
  --ss-text: var(--muted);
  --ss-text-faint: color-mix(in srgb, var(--muted) 70%, var(--surface));
  --ss-icon: var(--muted);
  --ss-icon-faint: var(--line-strong);
  --ss-accent: var(--accent);
  --ss-accent-2: var(--accent);
  --ss-accent-soft: var(--accent-soft);
  --ss-accent-text: var(--accent-ink);
  --ss-success: var(--accent);
  --ss-success-soft: var(--accent-soft);
  --ss-success-text: var(--accent-ink);
  --ss-font: var(--font-sans);
  --ss-mono: var(--font-mono);
  --ss-radius-sm: 6px;
  --ss-radius-md: var(--radius-sm);
  --ss-radius-lg: var(--radius-md);
  --ss-radius-window: var(--radius-lg);
  --ss-shadow-hero: 0 0 0 1px var(--line), 0 20px 48px rgba(20, 25, 20, 0.1), 0 2px 6px rgba(20, 25, 20, 0.06);
  --ss-shadow-satellite: 0 0 0 1px var(--line), 0 14px 32px -8px rgba(20, 25, 20, 0.18), 0 4px 10px -4px rgba(20, 25, 20, 0.08);
  --ss-shadow-ground: 0 0 0 1px var(--line), 0 18px 36px -20px rgba(20, 25, 20, 0.2);
  color: var(--ink);
  word-break: keep-all;
  overflow-wrap: break-word;
}

.dz .ss-stage[data-theme="dark"] {
  --ss-shadow-hero: 0 0 0 1px var(--line), 0 20px 48px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.35);
  --ss-shadow-satellite: 0 0 0 1px var(--line-strong), 0 14px 32px -8px rgba(0, 0, 0, 0.7);
  --ss-shadow-ground: 0 0 0 1px var(--line), 0 18px 36px -20px rgba(0, 0, 0, 0.7);
}

/* A phrase that never breaks inside (Netflix-subtitle line breaks) */
.dz .ph { display: inline-block; }

/* The app's own buttons: 보내기 dark, 고치기 tonal, 보내지 않기 text */
.dz-btn {
  display: inline-grid;
  grid-template-areas: 'stack';
  place-items: center;
  height: 32px;
  padding: 0 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--ink);
  background: var(--surface-2);
  transition: background-color 0.25s ease, color 0.25s ease, opacity 0.3s ease, transform 0.12s ease;
}
.dz-btn[data-pressed] { transform: scale(0.97); }
.dz-btn--send { background: var(--btn-bg); color: var(--btn-ink); min-width: 68px; }
.dz-btn--send[data-hover] { background: var(--btn-bg-hover); }
.dz-btn--text { background: transparent; color: var(--muted); padding: 0 8px; }
.dz-btn > * { grid-area: stack; }
.dz-layer {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  opacity: 0;
  filter: blur(2px);
  transition: opacity 0.22s ease, filter 0.22s ease;
}
.dz-layer[data-on] { opacity: 1; filter: none; transition-delay: 0.06s; }
.dz-btn--send .ss-check__ring { stroke: color-mix(in srgb, var(--btn-ink) 40%, transparent); }
.dz-btn--send .ss-check__arc { stroke: var(--btn-ink); }

/* The draft card's actions and its sent line share one cell, so nothing
   below moves when it turns to 보냈어요 */
.dz-acts-cell { display: grid; grid-template-areas: 'stack'; }
.dz-acts-cell > * { grid-area: stack; transition: opacity 0.3s ease, filter 0.3s ease; }
.dz-acts-cell > [data-off] { opacity: 0; filter: blur(2px); pointer-events: none; }
.dz-acts { display: flex; align-items: center; gap: 8px; }
.dz-sent {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  color: var(--accent-ink);
  font-size: 13px;
  font-weight: 600;
}
.dz-sent .dz-sent__time { color: var(--muted); font-weight: 400; }
.dz-sent .ss-check__fill { fill: var(--accent); }
.dz-sent .ss-check__tick { stroke: var(--surface); }

/* The draft card, as the web app draws it (web/js/10-reply-card.js) */
.dz-draft {
  display: grid;
  gap: 10px;
  padding: 14px 16px;
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: 0 0 0 1px var(--line);
}
.dz-draft__hd {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
}
.dz-draft__hd .dz-draft__title { color: var(--ink); font-size: 14px; font-weight: 600; }
.dz-draft__hd .ss-icon { color: var(--muted); }
.dz-draft__body {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--body);
  font-size: 13px;
  line-height: 1.55;
}
.dz-draft__to { display: flex; gap: 10px; font-size: 12.5px; color: var(--muted); }
.dz-draft__to b { color: var(--ink); font-weight: 500; }
`;document.head.appendChild(qc);va();var Wc=document.createElement("style");Wc.textContent=`/* Stageshow kit: the stage. Tokens, the looks (theme, palette,
   fidelity), edge fades, the still and placing switches, the keyframes more
   than one part shares, and the guards against host CSS. Imported by
   stage.tsx; every other component imports its own file. */

@layer stageshow {
  /* Stageshow kit. Tokens, the stage, the cursor, window chrome and faux atoms.
     Copy this file with the rest of kit/ and import it once. */

  .ss-fit {
    position: relative;
    width: 100%;
    /* Stopped at its design size in a wider slot, a stage sits in the middle
       of it, not against its left edge */
    margin-inline: auto;
  }

  .ss-stage {
    /* Surfaces */
    --ss-canvas: #f6f5f4;
    --ss-surface: #fff;
    --ss-chrome: #fff;

    /* Placeholder ink, lightest to darkest. Faux UI lives in these five. */
    --ss-ink-1: rgba(0, 0, 0, 0.04);
    --ss-ink-2: rgba(0, 0, 0, 0.06);
    --ss-ink-3: rgba(0, 0, 0, 0.08);
    /* ink-3 flattened onto the surface: an opaque fill for shapes that overlap
       (avatars in a pile), so the overlap never paints darker */
    --ss-fill: #ebebeb;
    --ss-ink-4: rgba(0, 0, 0, 0.1);
    --ss-ink-5: rgba(0, 0, 0, 0.15);

    /* Lines and real text */
    --ss-line: rgba(0, 0, 0, 0.06);
    --ss-line-faint: rgba(0, 0, 0, 0.04);
    /* Opaque, so icons that inherit them are one solid color (a translucent
       color paints darker wherever strokes meet) */
    --ss-text: #7a7a7d;
    --ss-text-strong: #262628;
    --ss-text-faint: #9a9a9d;
    /* Icons: opaque, so strokes that overlap or meet never paint darker. Never
       color an icon with a translucent ink or text token. */
    --ss-icon: #707074;
    --ss-icon-faint: #c4c4c7;

    /* One accent, spent on the thing being acted on. Status colors only
       where status is the subject. */
    --ss-accent: #3b82f6;
    --ss-accent-soft: rgba(59, 130, 246, 0.12);
    --ss-success: #22c55e;
    --ss-danger: #ef4444;
    --ss-warning: #f59e0b;

    /* The stage behind a framed shot */
    --ss-well: #efeeec;

    /* Status tints for diffs, badges and pills: soft fill, strong text */
    --ss-success-soft: rgba(34, 197, 94, 0.12);
    --ss-success-text: #15803d;
    --ss-danger-soft: rgba(239, 68, 68, 0.1);
    --ss-danger-text: #b91c1c;
    --ss-warning-soft: rgba(245, 158, 11, 0.14);
    --ss-warning-text: #b45309;
    /* A second accent stop, for gradient meters and lines */
    --ss-accent-2: #8b5cf6;
    /* The accent as text (a link, a selected label). Darkened so it reads on
       white; a custom accent gets the same treatment automatically */
    --ss-accent-text: color-mix(in srgb, var(--ss-accent) 82%, #000);

    /* Depth */
    --ss-shadow-window: 0 0 0 1px rgba(0, 0, 0, 0.06), 0 4px 16px rgba(0, 0, 0, 0.08);
    --ss-shadow-float: 0 0 0 1px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.12), 0 12px 32px rgba(0, 0, 0, 0.08);
    --ss-shadow-card: 0 1px 2px rgba(0, 0, 0, 0.04);
    /* Framing depth: the hero window on the stage, satellites over the hero */
    /* The ring gives every edge a line: the drop falls downward, so the top and
       a light sidebar on a light ground would otherwise vanish */
    --ss-shadow-hero: 0 0 0 1px rgba(0, 0, 0, 0.06), 0 30px 60px -12px rgba(50, 50, 93, 0.25), 0 18px 36px -18px rgba(0, 0, 0, 0.3);
    /* Something picked up and carried (a dragged card) */
    --ss-shadow-lift: 0 0 0 1px rgba(0, 0, 0, 0.04), 0 12px 28px -6px rgba(50, 50, 93, 0.28), 0 6px 12px -6px rgba(0, 0, 0, 0.16);
    /* Tight on purpose: a wide blur over a white window reads as a gray smear */
    --ss-raised: #fff;
    --ss-shadow-satellite: 0 0 0 1px rgba(0, 0, 0, 0.04), 0 14px 32px -8px rgba(50, 50, 93, 0.24), 0 4px 10px -4px rgba(0, 0, 0, 0.1);
    /* A small window resting on the stage's ground, not over another window:
       a hairline and a long, faint fall. The satellite's tight, dark contact
       shadow reads harsh under a small window on open ground */
    --ss-shadow-ground: 0 0 0 1px rgba(50, 50, 93, 0.06), 0 24px 48px -24px rgba(50, 50, 93, 0.18);

    --ss-font: system-ui, -apple-system, sans-serif;
    --ss-mono: "SF Mono", "SFMono-Regular", ui-monospace, Consolas, monospace;

    /* Shape: the radius scale the product's own parts use. A look sets these
       to its design system's values; each rounded part reads one */
    --ss-radius-sm: 6px; /* a menu row, a segment's thumb */
    --ss-radius-md: 8px; /* a field, a segmented track, a drop slot */
    --ss-radius-lg: 10px; /* a popover, a toast */
    --ss-radius-window: 12px; /* the product window */
    --ss-radius-pill: 999px; /* badges and chips */

    /* Density: the heights the parts are built on */
    --ss-control: 34px; /* a text field */
    --ss-row: 26px; /* a menu row, a segment */

    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    font-family: var(--ss-font);
    -webkit-font-smoothing: antialiased;
    user-select: none;
    /* The baseline every demo is designed against, pinned here so the host
       page's type (a blog's 15px body, its letter-spacing) never reaches in */
    font-size: 16px;
    font-weight: 400;
    font-style: normal;
    line-height: normal;
    letter-spacing: normal;
    word-spacing: normal;
    text-align: start;
    text-indent: 0;
    text-transform: none;
    white-space: normal;
    color: #000;
  }

  /* Orbs: a pale tile lit by a few huge, soft color orbs (Stage ground).
     Under everything in the scene (the stage is its own stacking context),
     so glass has color to take and white cards lift off it. Each orb is
     wider than the tile and mostly off it, so only its soft edge shows */
  .ss-ground {
    --ss-orb-1: #c9b8ff;
    --ss-orb-2: #ffc59a;
    --ss-orb-3: #a9d8ff;
    position: absolute;
    inset: 0;
    z-index: -1;
    overflow: hidden;
    /* A tile: set --ss-ground-radius to 0 for one that runs to the page's edges */
    border-radius: var(--ss-ground-radius, 20px);
    background:
      radial-gradient(60% 75% at 8% 4%, color-mix(in srgb, var(--ss-orb-1) 85%, transparent), transparent 70%),
      radial-gradient(55% 70% at 96% 92%, color-mix(in srgb, var(--ss-orb-2) 80%, transparent), transparent 70%),
      radial-gradient(45% 55% at 78% 8%, color-mix(in srgb, var(--ss-orb-3) 55%, transparent), transparent 70%),
      var(--ss-canvas);
    pointer-events: none;
  }

  .ss-stage[data-theme="dark"] .ss-ground {
    background:
      radial-gradient(60% 75% at 8% 4%, color-mix(in srgb, var(--ss-orb-1) 30%, transparent), transparent 70%),
      radial-gradient(55% 70% at 96% 92%, color-mix(in srgb, var(--ss-orb-2) 24%, transparent), transparent 70%),
      radial-gradient(45% 55% at 78% 8%, color-mix(in srgb, var(--ss-orb-3) 18%, transparent), transparent 70%),
      var(--ss-canvas);
  }

  .ss-stage[data-theme="dark"] {
    --ss-canvas: #111113;
    --ss-surface: #1a1a1d;
    --ss-chrome: #1d1d20;
    --ss-ink-1: rgba(255, 255, 255, 0.05);
    --ss-ink-2: rgba(255, 255, 255, 0.07);
    --ss-ink-3: rgba(255, 255, 255, 0.1);
    /* ink-3 flattened onto the surface: an opaque fill for shapes that overlap
       (avatars in a pile), so the overlap never paints darker */
    --ss-fill: #313134;
    --ss-ink-4: rgba(255, 255, 255, 0.13);
    --ss-ink-5: rgba(255, 255, 255, 0.2);
    --ss-line: rgba(255, 255, 255, 0.08);
    --ss-line-faint: rgba(255, 255, 255, 0.05);
    --ss-text: #9d9da1;
    --ss-text-strong: #ececee;
    --ss-text-faint: #6c6c70;
    --ss-icon: #9a9aa0;
    --ss-icon-faint: #4a4a50;
    --ss-accent-soft: rgba(59, 130, 246, 0.2);
    --ss-accent-text: color-mix(in srgb, var(--ss-accent) 70%, #fff);
    --ss-well: #0a0a0b;
    --ss-success-soft: rgba(34, 197, 94, 0.16);
    --ss-success-text: #4ade80;
    --ss-danger-soft: rgba(239, 68, 68, 0.16);
    --ss-danger-text: #f87171;
    --ss-warning-soft: rgba(245, 158, 11, 0.18);
    --ss-warning-text: #fbbf24;
    --ss-shadow-lift: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 12px 28px -6px rgba(0, 0, 0, 0.6);
    --ss-shadow-window: 0 0 0 1px rgba(255, 255, 255, 0.08), 0 4px 16px rgba(0, 0, 0, 0.4);
    --ss-shadow-float: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 4px 16px rgba(0, 0, 0, 0.4), 0 12px 32px rgba(0, 0, 0, 0.3);
    --ss-shadow-card: 0 0 0 1px rgba(255, 255, 255, 0.05);
    --ss-shadow-hero: 0 0 0 1px rgba(255, 255, 255, 0.08), 0 30px 60px -12px rgba(0, 0, 0, 0.6);
    /* On dark, depth comes mostly from a lighter surface: put satellites on
       --ss-raised. A wide blur on a dark window barely registers. */
    --ss-shadow-satellite: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 14px 32px -8px rgba(0, 0, 0, 0.7), 0 4px 10px -4px rgba(0, 0, 0, 0.5);
    --ss-shadow-ground: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 24px 48px -24px rgba(0, 0, 0, 0.6);
    --ss-raised: #26262a;
  }

  /* Blueprint: drawn, not painted. Surfaces become outlines on a blue ground. */
  .ss-stage[data-theme="blueprint"] {
    --ss-canvas: transparent;
    /* Opaque, a step lighter than the ground: the grid shows around UI, not
       through it */
    --ss-surface: #1857bd;
    --ss-raised: #1b5cc4;
    --ss-chrome: transparent;
    --ss-ink-1: rgba(214, 232, 255, 0.12);
    --ss-ink-2: rgba(214, 232, 255, 0.16);
    --ss-ink-3: rgba(214, 232, 255, 0.22);
    /* ink-3 flattened onto the surface: an opaque fill for shapes that overlap
       (avatars in a pile), so the overlap never paints darker */
    --ss-fill: #4277cc;
    --ss-ink-4: rgba(214, 232, 255, 0.3);
    --ss-ink-5: rgba(214, 232, 255, 0.45);
    --ss-line: rgba(214, 232, 255, 0.35);
    --ss-line-faint: rgba(214, 232, 255, 0.2);
    --ss-text: #b3c9ec;
    --ss-text-strong: #f0f6ff;
    --ss-text-faint: #7fa1da;
    --ss-icon: #c9dcf7;
    --ss-icon-faint: #6f97d6;
    --ss-accent: #ffffff;
    --ss-accent-soft: rgba(255, 255, 255, 0.15);
    --ss-success: #e6f0ff;
    --ss-danger: #e6f0ff;
    --ss-warning: #e6f0ff;
    /* Status reads by mark and word on blueprint, never by green or red */
    --ss-success-soft: rgba(255, 255, 255, 0.14);
    --ss-danger-soft: rgba(255, 255, 255, 0.14);
    --ss-warning-soft: rgba(255, 255, 255, 0.14);
    --ss-success-text: #ffffff;
    --ss-danger-text: #ffffff;
    --ss-warning-text: #ffffff;
    --ss-well: #1450b4;
    --ss-shadow-window: 0 0 0 1px rgba(214, 232, 255, 0.55);
    --ss-shadow-float: 0 0 0 1px rgba(214, 232, 255, 0.7);
    --ss-shadow-card: 0 0 0 1px rgba(214, 232, 255, 0.35);
    --ss-shadow-hero: 0 0 0 1px rgba(214, 232, 255, 0.55);
    --ss-shadow-satellite: 0 0 0 1px rgba(214, 232, 255, 0.8);
    --ss-shadow-ground: 0 0 0 1px rgba(214, 232, 255, 0.7);
    background-color: var(--ss-well);
    background-image:
      linear-gradient(rgba(214, 232, 255, 0.08) 1px, transparent 1px),
      linear-gradient(90deg, rgba(214, 232, 255, 0.08) 1px, transparent 1px);
    background-size: 16px 16px;
    /* Shift the grid so window edges sit on its lines: a 24px gutter wants 8px */
    background-position: var(--ss-grid-x, 0) var(--ss-grid-y, 0);
  }

  /* Glass: frosted, translucent panels over a soft color field drawn from the
     accent. Panels blur what's behind them; text and icons stay opaque. Give
     your own panels the class ss-glass to frost them too. */
  .ss-stage[data-theme="glass"] {
    --ss-canvas: rgba(255, 255, 255, 0.5);
    --ss-surface: rgba(255, 255, 255, 0.62);
    --ss-chrome: rgba(255, 255, 255, 0.38);
    --ss-raised: rgba(255, 255, 255, 0.74);
    --ss-line: rgba(255, 255, 255, 0.65);
    --ss-line-faint: rgba(255, 255, 255, 0.45);
    --ss-well: #ebe9f5;
    --ss-shadow-window: inset 0 0 0 1px rgba(255, 255, 255, 0.75), 0 20px 50px -14px rgba(40, 40, 90, 0.28);
    --ss-shadow-hero: inset 0 0 0 1px rgba(255, 255, 255, 0.75), 0 30px 60px -16px rgba(40, 40, 90, 0.3);
    --ss-shadow-satellite: inset 0 0 0 1px rgba(255, 255, 255, 0.85), 0 16px 36px -10px rgba(40, 40, 90, 0.32);
    --ss-shadow-float: inset 0 0 0 1px rgba(255, 255, 255, 0.85), 0 12px 32px -8px rgba(40, 40, 90, 0.28);
    --ss-shadow-ground: inset 0 0 0 1px rgba(255, 255, 255, 0.85), 0 24px 48px -24px rgba(40, 40, 90, 0.24);
    --ss-shadow-card: inset 0 0 0 1px rgba(255, 255, 255, 0.6);
    background:
      radial-gradient(55% 65% at 12% 18%, color-mix(in srgb, var(--ss-accent) 42%, transparent), transparent 70%),
      radial-gradient(50% 60% at 88% 28%, color-mix(in srgb, var(--ss-accent-2) 38%, transparent), transparent 70%),
      radial-gradient(60% 55% at 58% 100%, rgba(255, 168, 120, 0.42), transparent 70%),
      var(--ss-well);
  }

  .ss-stage[data-theme="glass"] .ss-window,
  .ss-stage[data-theme="glass"] .ss-popover,
  .ss-stage[data-theme="glass"] .ss-glass {
    backdrop-filter: blur(24px) saturate(1.6);
    -webkit-backdrop-filter: blur(24px) saturate(1.6);
  }

  /* Cool grays (Stage greys="cool"): the canvas and well lose their warmth,
     for a scene that wants one cool family (macOS, a blue ground). Light
     theme only; dark, blueprint and glass have their own grounds */
  .ss-stage[data-greys="cool"]:not([data-theme="dark"], [data-theme="blueprint"], [data-theme="glass"]) {
    --ss-canvas: #f4f5f8;
    --ss-well: #eceef2;
  }

  /* Grayscale: the accent and status colors fall back to the strongest ink */
  .ss-stage[data-palette="mono"] {
    --ss-accent: #1a1a1a;
    --ss-accent-soft: rgba(0, 0, 0, 0.06);
    --ss-success: #1a1a1a;
    --ss-danger: #1a1a1a;
    --ss-warning: #1a1a1a;
    --ss-accent-2: #1a1a1a;
    --ss-success-text: #1a1a1a;
    --ss-danger-text: #1a1a1a;
    --ss-success-soft: rgba(0, 0, 0, 0.06);
    --ss-danger-soft: rgba(0, 0, 0, 0.04);
  }

  .ss-stage[data-palette="mono"][data-theme="dark"] {
    --ss-accent: #f2f2f2;
    --ss-accent-soft: rgba(255, 255, 255, 0.1);
    --ss-success: #f2f2f2;
    --ss-danger: #f2f2f2;
    --ss-warning: #f2f2f2;
    --ss-accent-2: #f2f2f2;
    --ss-success-text: #f2f2f2;
    --ss-danger-text: #f2f2f2;
    --ss-success-soft: rgba(255, 255, 255, 0.1);
    --ss-danger-soft: rgba(255, 255, 255, 0.06);
  }

  /* Images, logos and avatars lose their color in grayscale */
  .ss-stage[data-palette="mono"] img,
  .ss-stage[data-palette="mono"] .ss-keep-mono {
    filter: grayscale(1);
  }

  /* Edge fades. A crop must explain itself: content fades into the page
     instead of being sliced. Length via --ss-fade. */
  .ss-fade-b { mask-image: linear-gradient(to bottom, #000 calc(100% - var(--ss-fade, 64px)), transparent); }

  .ss-fade-r { mask-image: linear-gradient(to right, #000 calc(100% - var(--ss-fade, 64px)), transparent); }

  .ss-fade-br {
    mask-image:
      linear-gradient(to bottom, #000 calc(100% - var(--ss-fade, 64px)), transparent),
      linear-gradient(to right, #000 calc(100% - var(--ss-fade, 64px)), transparent);
    mask-composite: intersect;
  }

  /* A layer that steps back when another comes forward */
  .ss-recede {
    transition: opacity 0.3s ease;
  }

  .ss-recede[data-receded="true"] {
    opacity: 0.4;
  }

  /* Transitions off for one patch (act.snap), stage-wide or in one target */
  .ss-stage [data-instant],
  .ss-stage[data-instant] *,
  .ss-stage [data-instant] *,
  .ss-stage[data-instant] *::before,
  .ss-stage[data-instant] *::after {
    transition: none !important;
  }

  @keyframes ss-spin {
    to { transform: rotate(1turn); }
  }

  @keyframes ss-fade-in {
    from { opacity: 0; filter: blur(2px); transform: translateY(3px); }
  }

  /* A still (reduced motion, or no script) is the poster, settled: nothing in
     it transitions or animates, so it never shows a frame caught mid-fade */
  .ss-stage[data-still] *,
  .ss-stage[data-still] *::before,
  .ss-stage[data-still] *::after {
    transition: none !important;
    animation: none !important;
  }

  /* Offscreen resets settle immediately. Pausing keyframes alone leaves
     newly-created CSS transitions running after the story clock stops.
     Visible hover exits keep their normal glide; completed once scenes hold. */
  .ss-stage[data-offscreen],
  .ss-stage[data-offscreen] *,
  .ss-stage[data-offscreen] *::before,
  .ss-stage[data-offscreen] *::after {
    transition: none !important;
    animation-play-state: paused !important;
  }

  /* Settling (first paint, a layout switch): things placed from measurements
     arrive in place instead of traveling there. Entrance animations still play. */
  .ss-stage[data-placing] *,
  .ss-stage[data-placing] *::before,
  .ss-stage[data-placing] *::after {
    transition: none !important;
  }

  .ss-stage *,
  .ss-stage *::before,
  .ss-stage *::after {
    box-sizing: border-box;
  }

  /* The auto cursor's hit test (stage.tsx): for that one read, everything
     counts as hittable except the cursor itself */
  .ss-stage[data-hit] * {
    pointer-events: auto !important;
  }
}

/* Outside the layer, on purpose. Everything above is in @layer stageshow so
   a demo's own (unlayered) CSS always wins over the kit. These few rules are
   different: they exist to beat the host page's CSS, and an unlayered host
   rule (a blog's \`p { margin }\`, \`img { max-width: 100% }\`) would beat
   anything in a layer. So they stay unlayered.

   Their specificity is pitched between the two: three type selectors'
   worth (\`:where()\` adds nothing, each \`:not(html)\`-style test adds one
   type), so they beat a host's element rules (\`p\`, \`article p\`) but lose to
   any class, which keeps a demo's own class rules winning whatever order the
   files load in. A bundler can load the kit's CSS again after a demo's (one
   copy per lazily loaded chunk), so order can't be relied on here. */

/* A host page's element rules (a blog's p margins, link colors, list
   bullets) roll back to the browser's defaults inside a stage, which is what
   every demo is designed against. A host that styles prose through a class
   (.article p) out-ranks this: exclude stages there with
   :not(:where(.ss-stage *)). */
:where(.ss-stage) :is(p, h1, h2, h3, h4, h5, h6, ul, ol, li, dl, dt, dd, a, figure, figcaption, blockquote, pre, code, hr, table, th, td, button, input, label):not(html):not(body) {
  all: revert;
}

/* A universal reset (Tailwind v3's preflight: \`* { border-width: 0;
   box-sizing: border-box }\`) is unlayered, so it would beat the kit's own
   borders, box model and spacing (a bare \`* { padding: 0 }\` put window
   lights flush against the edge on a blog). revert-layer hands each property back to the kit's
   layer. One type selector's worth, so it beats \`*\` but not a host's element
   rules, which the guard above already handles */
:where(.ss-stage, .ss-stage *, .ss-stage ::before, .ss-stage ::after):not(html) {
  border-width: revert-layer;
  border-style: revert-layer;
  border-color: revert-layer;
  box-sizing: revert-layer;
  padding: revert-layer;
  margin: revert-layer;
}

/* Hosts often cap images and SVGs at their container (max-width: 100%),
   which squeezes an icon or ring drawn larger than its slot off-center.
   Tailwind v3 also aligns them to the middle */
:where(.ss-stage) :is(svg, img):not(html):not(body) {
  max-width: none;
  vertical-align: revert-layer;
}

/* What a Fly or an Expand carries stays inside it, so its own max-width has
   to beat the guard above, which a layered rule can't: one type more */
:where(.ss-stage :is(.ss-fly__lift, .ss-expand__face)) > :is(svg, img):not(html):not(body):not(head) {
  max-width: 100%;
}
`;document.head.appendChild(Wc);ii();var Vc=document.createElement("style");Vc.textContent=`/* Keystrokes (act.key): the keycap rows. */

@layer stageshow {
  .ss-keys {
    position: absolute;
    bottom: 16px;
    left: 50%;
    z-index: 99;
    display: flex;
    gap: 4px;
    opacity: 0;
    transform: translate(-50%, 6px) scale(0.96);
    transition: opacity 0.16s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
    pointer-events: none;
  }

  .ss-keys[data-show="true"] {
    opacity: 1;
    transform: translate(-50%, 0) scale(1);
  }

  .ss-keys[data-at="top"] {
    top: 16px;
    bottom: auto;
  }

  .ss-keys[data-at="bottom-left"],
  .ss-keys[data-at="bottom-right"] {
    left: auto;
    transform: translateY(6px) scale(0.96);
  }

  .ss-keys[data-at="bottom-left"] { left: 16px; }

  .ss-keys[data-at="bottom-right"] { right: 16px; }

  .ss-keys[data-at="bottom-left"][data-show="true"],
  .ss-keys[data-at="bottom-right"][data-show="true"] {
    transform: none;
  }

  .ss-key {
    display: grid;
    place-items: center;
    min-width: 28px;
    height: 28px;
    padding: 0 8px;
    border-radius: 7px;
    background: rgba(24, 24, 27, 0.88);
    box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.18);
    color: #fff;
    font: 500 13px/1 var(--ss-font);
    transition: transform 0.08s ease-out, box-shadow 0.08s ease-out;
  }

  .ss-key[data-down="true"] {
    transform: translateY(1px) scale(0.94);
    box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.4), 0 2px 6px rgba(0, 0, 0, 0.18);
  }
}
`;document.head.appendChild(Vc);va();var Bh=Symbol.for("react.element"),Eh=Symbol.for("react.fragment"),Nh=Object.prototype.hasOwnProperty,Oh=Mn.ReactCurrentOwner,Uh={key:!0,ref:!0,__self:!0,__source:!0};function Gc(e,a,t){var n,r={},o=null,s=null;t!==void 0&&(o=""+t),a.key!==void 0&&(o=""+a.key),a.ref!==void 0&&(s=a.ref);for(n in a)Nh.call(a,n)&&!Uh.hasOwnProperty(n)&&(r[n]=a[n]);if(e&&e.defaultProps)for(n in a=e.defaultProps,a)r[n]===void 0&&(r[n]=a[n]);return{$$typeof:Bh,type:e,key:o,ref:s,props:r,_owner:Oh.current}}var Ma=Eh,i=Gc,L=Gc;var Hh={cmd:"⌘",shift:"⇧",alt:"⌥",option:"⌥",ctrl:"⌃",enter:"↵",return:"↵",esc:"esc",tab:"⇥",up:"↑",down:"↓",left:"←",right:"→",backspace:"⌫"},jc=(e)=>e.split("+").map((a)=>Hh[a.trim().toLowerCase()]??a.trim().toUpperCase());function Kc({rows:e,at:a}){return i(Ma,{children:e.map((t)=>t&&i("div",{className:"ss-keys","data-show":t.show,"data-at":a,"aria-hidden":!0,children:t.caps.map((n,r)=>i("kbd",{className:"ss-key","data-down":t.down,children:n},r))},t.id))})}var ks={x:0,y:0,width:0,height:0},Ss=(e)=>typeof e==="string"?e:("at"in e)?e.at:null;var Xc=(e,a)=>e?.offsetWidth&&e.getBoundingClientRect().width/e.offsetWidth||a||1;function Ps(e,a){let t=e.getBoundingClientRect();return{left:t.left,top:t.top,scale:e.offsetWidth&&t.width/e.offsetWidth||a||1,borderX:e.clientLeft,borderY:e.clientTop}}function Dt(e,a,t,n=Ps(e,t)){let r=a.getBoundingClientRect(),{scale:o}=n;return{x:(r.left-n.left)/o-n.borderX,y:(r.top-n.top)/o-n.borderY,width:r.width/o,height:r.height/o}}function $c(e,a,t,n=Ps(e,t)){let r=Dt(e,a,t,n),o=getComputedStyle(a),s=o.transform,l=s&&s!=="none"?s.match(/^matrix\(([^)]+)\)$/):null;if(!l)return r;let[u,c,m,g,h,x]=l[1].split(",").map(Number);if(c||m||h||x||!u||!g)return r;let v=r.width/u,k=r.height/g,[B,f]=o.transformOrigin.split(" ").map(parseFloat);return{x:r.x-B*(1-u),y:r.y-f*(1-g),width:v,height:k}}var qh=(e)=>{let a=getComputedStyle(e);return a.transform!=="none"||a.translate&&a.translate!=="none"||a.scale&&a.scale!=="none"||a.rotate&&a.rotate!=="none"};function Qc(e,a){let t=!0;for(let s=a;s&&s!==e;s=s.parentElement)if(qh(s)){t=!1;break}if(t)return Dt(e,a,1);let n=0,r=0,o=a;while(o&&o!==e){n+=o.offsetLeft,r+=o.offsetTop;let s=o.offsetParent;if(!s||!e.contains(s))break;if(o=s,o!==e)n+=o.clientLeft-o.scrollLeft,r+=o.clientTop-o.scrollTop}return{x:n,y:r,width:a.offsetWidth,height:a.offsetHeight}}function di(e,a){let t=Object.keys(e);if(t.length!==Object.keys(a).length)return!1;return t.every((n)=>{let r=e[n],o=a[n];return o&&Math.abs(r.x-o.x)<0.5&&Math.abs(r.y-o.y)<0.5&&Math.abs(r.width-o.width)<0.5&&Math.abs(r.height-o.height)<0.5})}function bs(e){let a=e.parentElement;if(!a?.classList.contains("ss-scroller"))return;let{clientHeight:t,scrollHeight:n}=e,r=n>t?Math.max(24,t/n*t):0,o=n>t?e.scrollTop/(n-t)*(t-r):0;a.style.setProperty("--ss-thumb-h",`${r}px`),a.style.setProperty("--ss-thumb-y",`${o}px`)}var Wh={house:[0.65,0,0.1,1],through:[0.8,0,0.1,1],settle:[0.05,0.85,0.3,1],enter:[0.1,0.8,0.3,0.95],trip:[0.78,0,0.17,1],camera:[0.45,0,0.1,1]};function Zc(e){let[a,t,n,r]=typeof e==="string"?Wh[e]:e,o=3*a,s=3*(n-a)-o,l=1-o-s,u=3*t,c=3*(r-t)-u,m=1-u-c,g=(x)=>((l*x+s)*x+o)*x,h=(x)=>(3*l*x+2*s)*x+o;return(x)=>{if(x<=0)return 0;if(x>=1)return 1;let v=x;for(let k=0;k<8;k++){let B=h(v);if(Math.abs(B)<0.000001)break;let f=v-(g(v)-x)/B;if(f<0||f>1)break;v=f}if(Math.abs(g(v)-x)>0.000001){let k=0,B=1;for(let f=0;f<40;f++)if(v=(k+B)/2,g(v)<x)k=v;else B=v}return((m*v+c)*v+u)*v}}function fi(){try{return!1}catch{return!0}}function dt(e){if(fi())console.warn(`[stageshow] ${e}`)}var ft=(e,a,t)=>Math.min(t,Math.max(a,e)),In=(e)=>e<0.5?4*e*e*e:1-Math.pow(-2*e+2,3)/2,Yc=(e)=>{let a=Math.sin(e*12.9898)*43758.5453;return a-Math.floor(a)};var Jc=(e)=>{if(!e)return;window.setTimeout(()=>e.removeAttribute("data-touching"),240)};class ct extends Error{}function ep(e,a){let{rootRef:t,cursorRef:n,pos:r,hovered:o,kindRef:s,keysRef:l,dragging:u,autoUsed:c,autoRef:m,scaleRef:g,speed:h,layout:x,cursor:v,resolve:k,place:B,remeasure:f,ripple:d,setState:p,setKind:w,setKeys:A,setLastKeys:F}=a,z=Zc("enter"),y=()=>{if(e.aborted)throw new ct},re=(b,S)=>new Promise((I,P)=>{y();let M=()=>{S(O),e.removeEventListener("abort",M),P(new ct)},O=b(()=>{if(e.removeEventListener("abort",M),e.aborted)P(new ct);else I()});e.addEventListener("abort",M,{once:!0})}),D=()=>re((b)=>requestAnimationFrame(b),cancelAnimationFrame),K=(b)=>re((S)=>setTimeout(S,b/h),clearTimeout),Ua=(b)=>{let S=!0,I=()=>{if(!S)return;S=!1,e.removeEventListener("abort",I),b()};return e.addEventListener("abort",I,{once:!0}),I},Bt=async(b,S)=>{let I=performance.now(),P=b/h;for(;;){y();let M=Math.min(1,(performance.now()-I)/P);if(S(M),M===1)return;await D()}},Et=(b)=>{let S=[];for(let I=b;I&&I!==t.current;I=I.parentElement)if(I.hasAttribute("data-target"))S.push(I);return S},gt=(b)=>{let S=t.current;if(!S)return;let I=S.querySelectorAll("[data-cursor]");if(!I.length&&!c.current)return;if(I.length)c.current=!0;let P=S.getBoundingClientRect(),M=P.width/S.offsetWidth||1,O=S.dataset.cursorBase??"pointer",X=O;S.setAttribute("data-hit","");let ue=document.elementsFromPoint(P.left+b.x*M,P.top+b.y*M);S.removeAttribute("data-hit");let E=ue.find((N)=>{if(!S.contains(N)||N.closest(".ss-cursor, .ss-keys, .ss-ripple"))return!1;if(getComputedStyle(N).pointerEvents==="none"&&!N.closest('[data-cursor], [data-target], button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="tab"]'))return!1;let ie=1;for(let G=N;G&&G!==S.parentElement;G=G.parentElement){let fe=getComputedStyle(G);if(fe.visibility==="hidden")return!1;ie*=Number(fe.opacity)}return ie>0.15});if(E){let N=E.closest('[data-cursor], button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="tab"]');if(X=N&&S.contains(N)&&N.dataset.cursor?N.dataset.cursor:O,X!==s.current)w(X);return}if(I.forEach((N)=>{let ie=N.getBoundingClientRect(),G=(ie.left-P.left)/M,fe=(ie.top-P.top)/M;if(b.x>=G&&b.x<=G+ie.width/M&&b.y>=fe&&b.y<=fe+ie.height/M)X=N.dataset.cursor}),X!==s.current)w(X)};if(m.current=gt,!u.current)gt(r.current);let ga=(b)=>{if(o.current===b)return;let S=Et(b);Et(o.current).forEach((I)=>S.includes(I)||I.removeAttribute("data-hover")),S.forEach((I)=>I.setAttribute("data-hover","")),o.current=b},we=l.current.id,Xe=0,ra=(b)=>{let S=Ss(b);return S===null?null:t.current?.querySelector(`[data-target="${S}"]`)??null},Ie={get signal(){return e},put(b){if(!e.aborted)p((S)=>({...S,...typeof b==="function"?b(S):b}))},async set(b){y(),Ie.put(b),await D(),await D(),m.current?.(r.current),y()},wait:async(b)=>{y(),await K(b)},rect:(b,S)=>{let I=t.current,P=I?.querySelector(`[data-target="${b}"]`);if(!I||!P)return dt(`no element with data-target="${b}"`),ks;return S?.layout?Qc(I,P):Dt(I,P,g.current)},center:(b)=>k(b),caret(b,S){Xe++;let I=ra(b),P=t.current;if(!I||!P)return 0;let M=P.getBoundingClientRect(),O=M.width/P.offsetWidth||1,X=M.left+S.x*O,ue=M.top+S.y*O,E=[],N=document.createTreeWalker(I,NodeFilter.SHOW_TEXT),ie=document.createRange(),G=0,fe=(V)=>{for(let ke=V.parentElement;ke;ke=ke===I?null:ke.parentElement){let Z=getComputedStyle(ke);if(Z.opacity==="0"||Z.visibility==="hidden"||Z.display==="none")return!0}return!1};for(let V=N.nextNode();V;V=N.nextNode()){let ke=V.textContent??"";if(fe(V))continue;for(let Z=0;Z<ke.length;Z++){ie.setStart(V,Z),ie.setEnd(V,Z+1);let me=ie.getBoundingClientRect();if(me.width||me.height)E.push({left:me.left,right:me.right,mid:(me.left+me.right)/2,top:me.top,bottom:me.bottom,at:G+Z})}G+=ke.length}if(!E.length)return 0;if(ue<E[0].top)return 0;if(ue>E[E.length-1].bottom)return G;let Re=E[0];for(let V of E)if(Math.abs((V.top+V.bottom)/2-ue)<Math.abs((Re.top+Re.bottom)/2-ue))Re=V;let Ce=E.filter((V)=>Math.abs(V.top-Re.top)<(Re.bottom-Re.top)/2),Nt=Ce.find((V)=>V.mid>X);return Nt?Nt.at:Ce[Ce.length-1].at+1},async move(b,S){y();let I={...r.current},P=k(b),M=Math.hypot(P.x-I.x,P.y-I.y);if(M<0.5)return ga(ra(b));let O=Et(ra(b));ga(Et(o.current).find((G)=>O.includes(G))??null);let X=S?.duration??ft(260+M*0.9,300,650),ue=In,E=Math.min(M*0.08,24),N=-(P.y-I.y)/M,ie=(P.x-I.x)/M;await Bt(X,(G)=>{let fe=ue(G),Re=Math.sin(Math.PI*fe)*E,Ce=S?.path?S.path(fe,I,P):{x:I.x+(P.x-I.x)*fe+N*Re,y:I.y+(P.y-I.y)*fe+ie*Re};if(B(Ce),gt(Ce),S?.onMove)Cs(()=>S.onMove(Ce,I,G))}),y(),ga(ra(b))},async click(b,S){if(y(),b!==void 0)await Ie.move(b),await K(120);y();let I=b!==void 0?ra(b):o.current,P=n.current,M=v?.style==="touch",O=Ua(()=>{if(P?.removeAttribute("data-pressed"),I?.removeAttribute("data-pressed"),M)Jc(P)});try{if(M)P?.setAttribute("data-touching",""),await K(140),y();for(let X=0;X<(S?.double?2:1);X++){if(X)await K(70);if(y(),P?.setAttribute("data-pressed","true"),v?.ripple)d(r.current);I?.setAttribute("data-pressed",S?.right?"right":""),await K(S?.double?80:100),y(),P?.removeAttribute("data-pressed"),I?.removeAttribute("data-pressed")}}finally{O()}},async scroll(b,S,I){y();let P=ra(b);if(!P)return;let M=P.scrollTop,O=typeof S==="number"?S:M;if(typeof S==="string"){let E=ra(S);if(E)O=M+(E.getBoundingClientRect().top-P.getBoundingClientRect().top)/Xc(t.current,g.current)-(I?.offset??0)}if(O=ft(O,0,P.scrollHeight-P.clientHeight),v){let E=Dt(t.current,P,g.current||1),N=r.current;if(!(N.x>=E.x+8&&N.x<=E.x+E.width-8&&N.y>=E.y+8&&N.y<=E.y+E.height-8))await this.move({x:E.x+E.width*0.6,y:E.y+E.height*0.55}),await this.wait(120)}let X=P.parentElement?.classList.contains("ss-scroller")?P.parentElement:null;X?.setAttribute("data-scrolling","");let ue=Ua(()=>X?.removeAttribute("data-scrolling"));try{await Bt(I?.duration??ft(420+Math.abs(O-M)*1.2,500,1400),(E)=>{P.scrollTop=M+(O-M)*In(E),P.toggleAttribute("data-scrolled",P.scrollTop>0.5),bs(P)}),y()}finally{ue()}f(),m.current?.(r.current)},async snap(b,S){y();let I=S?t.current?.querySelector(`[data-target="${S}"]`):t.current;I?.setAttribute("data-instant","");let P=Ua(()=>I?.removeAttribute("data-instant"));try{Ie.put(b),await D(),await D(),y()}finally{P()}},async key(b){y();let S=jc(b),I=++we,P=l.current;F(P.caps.length?{...P,show:!1,down:!1}:null),A({id:I,caps:S,show:!1,down:!1}),await D(),await D(),y(),A({id:I,caps:S,show:!0,down:!1}),await K(180),y(),A({id:I,caps:S,show:!0,down:!0}),await K(140),y(),A({id:I,caps:S,show:!0,down:!1}),K(600).then(()=>{if(we===I&&!e.aborted)A({id:I,caps:S,show:!1,down:!1})},(M)=>{if(!(M instanceof ct))console.error("[stageshow] script error",M)})},async stagger(b,S,I=60){await Promise.all(b.map(async(P,M)=>{if(M)await K(I*M);y(),await S(P,M)}))},mark(b){if(!e.aborted)t.current?.setAttribute("data-mark",b)},async cursor(b){y(),w(b),await D()},async type(b,S,I){let P=I?.interval??35;for(let M=0;M<=S.length;M++)y(),p((O)=>({...O,[b]:S.slice(0,M)})),await K(P*(0.7+0.6*Yc(M)))},place(b){if(e.aborted)return;let S=k(b);B(S),m.current?.(S)},async enter(b,S){y();let I=k(b),P=t.current,M={x:0,y:0,w:P.offsetWidth,h:P.offsetHeight},O=40,X=[I.x-M.x,M.x+M.w-I.x,I.y-M.y,M.y+M.h-I.y],ue=X.indexOf(Math.min(...X)),E=ue===0?{x:M.x-O,y:I.y+M.h*0.12}:ue===1?{x:M.x+M.w+O*0.4,y:I.y+M.h*0.12}:ue===2?{x:I.x-M.w*0.06,y:M.y-O}:{x:I.x+M.w*0.06,y:M.y+M.h+O*0.4};B(E),ga(null),await Bt(S?.duration??700,(N)=>{let ie=z(N),G={x:E.x+(I.x-E.x)*ie,y:E.y+(I.y-E.y)*ie};B(G),gt(G)}),y(),ga(ra(b))},async drag(b,S,I){y();let P={...r.current},M=k(b),O=Math.hypot(M.x-P.x,M.y-P.y);ga(null);let X=s.current,ue=X==="ibeam"||X==="crosshair",E=!ue&&I?.cursor!=="preserve",N=v?.style==="touch",ie=(V)=>V<0.25?V*V/0.5*1.1428571428571428:(V-0.125)*1.1428571428571428;if(N)n.current?.setAttribute("data-touching",""),await K(140),y();let G=N?n.current?.querySelector(".ss-cursor__streak")??null:null,fe=[],Re=(V)=>{if(fe.unshift({...V}),fe.length>9)fe.pop();let ke=fe[fe.length-1],Z=V.x-ke.x,me=V.y-ke.y,Ot=Math.min(Math.hypot(Z,me),100);if(!G)return;G.style.width=`${Ot}px`,G.style.left=`${-Ot}px`,G.style.transform=`rotate(${Math.atan2(me,Z)}rad)`};u.current=!0;let Ce=n.current,Nt=Ua(()=>{if(u.current=!1,Ce?.removeAttribute("data-pressed"),Ce?.removeAttribute("data-swiping"),N)Jc(Ce)});try{if(Ce?.setAttribute("data-pressed","true"),await K(N?170:60),N){if(G)G.style.width="0px";Ce?.setAttribute("data-swiping","")}if(y(),E&&!N)w("grab");if(!N)await K(70);y(),Ce?.removeAttribute("data-pressed");let V=ue?0:Math.min(O*0.06,18),ke=O?-(M.y-P.y)/O:0,Z=O?(M.x-P.x)/O:0,me=ue&&Math.abs(M.y-P.y)>6;if(me&&M.y>P.y&&M.x<P.x-2)dt("a text selection that ends left of where it starts overshoots and shrinks back; select text that starts a line, or fits on one");let Ot=Xe;if(await Bt(N?I?.duration??ft(180+O*0.5,240,300):I?.duration??ft(360+O*1.1,450,900),(kn)=>{let xa=N?ie(kn):In(kn),Ut=Math.sin(Math.PI*xa)*V,to=me?1-(1-xa)*(1-xa):xa,no=me?xa*xa:xa,Ht=I?.path?.(xa,P,M)??{x:P.x+(M.x-P.x)*no+ke*Ut,y:P.y+(M.y-P.y)*to+Z*Ut};if(Cs(()=>S?.(Ht,P,kn)),B(Ht),N)Re(Ht)}),ue&&S&&Xe===Ot)dt("selection drift: a text selection drag never read a.caret(), so the highlight is not under the I-beam; set it from a.caret(name, at) in onMove");if(y(),E&&!N)w(X==="grab"?"pointer":X)}finally{Nt()}m.current?.(M)},layout:x};for(let b of Object.keys(Ie)){let S=Ie[b];if(typeof S!=="function")continue;Ie[b]=(...I)=>{let P=S.apply(Ie,I);if(P instanceof Promise)P.catch((M)=>{if(!(M instanceof ct))console.error("[stageshow] script error",M)});return P}}return Ie}function ap(e,a,t,n){let r=Object.keys(a).filter((o)=>JSON.stringify(e[o])!==JSON.stringify(a[o]));if(r.length)dt(`loop seam: state still differs from initial at the end of the script (${r.join(", ")})`);if(n&&Math.hypot(t.x-n.x,t.y-n.y)>1)dt("loop seam: cursor does not end where it starts")}function np(){return i("svg",{height:"24",width:"24",viewBox:"0 0 32 32",fill:"none",children:L("g",{transform:"translate(10 7)",children:[i("path",{d:"m6.148 18.473 1.863-1.003 1.615-.839-2.568-4.816h4.332l-11.379-11.408v16.015l3.316-3.221z",fill:"#fff"}),i("path",{d:"m6.431 17 1.765-.941-2.775-5.202h3.604l-8.025-8.043v11.188l2.53-2.442z",fill:"#000"})]})})}function rp(){return L("svg",{width:"10",height:"16",viewBox:"0 0 10 16",fill:"none",overflow:"visible",children:[i("path",{d:"M3 1H7M3 15H7M5 1V15",style:{stroke:"var(--ss-cursor-edge, #fff)"},strokeWidth:"2.6",strokeLinecap:"round"}),i("path",{d:"M3 1H7M3 15H7M5 1V15",style:{stroke:"var(--ss-cursor-line, #000)"},strokeWidth:"1",strokeLinecap:"round"})]})}function op(){return L("svg",{width:"17",height:"17",viewBox:"0 0 17 17",fill:"none",overflow:"visible",children:[i("path",{d:"M8.5 0V17M0 8.5H17",style:{stroke:"var(--ss-cursor-edge, #fff)"},strokeWidth:"2.6"}),i("path",{d:"M8.5 0V17M0 8.5H17",style:{stroke:"var(--ss-cursor-line, #000)"},strokeWidth:"1"})]})}function sp(){return L("svg",{width:"26",height:"26",viewBox:"0 0 32 32",fill:"none",children:[i("path",{d:"M10.6 6a1.7 1.7 0 0 1 3.4 0v6.6a1.3 1.3 0 0 1 2.6 0v.7a1.3 1.3 0 0 1 2.6 0v.7a1.3 1.3 0 0 1 2.6 0V19c0 3.1-2 5.6-5 5.6h-2.6c-2 0-3.3-.9-4.4-2.4l-3.1-4.1c-.6-.9-.4-2 .5-2.5.8-.4 1.7-.2 2.3.5l1.1 1.4V6Z",fill:"#fff",stroke:"#000",strokeWidth:"1.1",strokeLinejoin:"round"}),i("path",{d:"M14 12.6v3.6M16.6 13.3v3M19.2 14v2.6",stroke:"#000",strokeWidth:"1",strokeLinecap:"round"})]})}function lp(){return i("svg",{width:"26",height:"26",viewBox:"0 0 32 32",fill:"none",children:L("g",{transform:"translate(7 6)",children:[i("path",{d:"m4.5557 8.5742c-.098-.375-.196-.847-.406-1.552-.167-.557-.342-.859-.47-1.233-.155-.455-.303-.721-.496-1.181-.139-.329-.364-1.048-.457-1.44-.119-.509.033-.924.244-1.206.253-.339.962-.49 1.357-.351.371.13.744.512.916.788.288.46.357.632.717 1.542.393.992.564 1.918.611 2.231l.085.452c-.001-.04-.043-1.122-.044-1.162-.035-1.029-.06-1.823-.038-2.939.002-.126.064-.587.084-.715.078-.5.305-.8.673-.979.412-.201.926-.215 1.401-.017.423.173.626.55.687 1.022.014.109.094.987.093 1.107-.013 1.025.006 1.641.015 2.174.004.231.003 1.625.017 1.469.061-.656.094-3.189.344-3.942.144-.433.405-.746.794-.929.431-.203 1.113-.07 1.404.243.285.305.446.692.482 1.153.032.405-.019.897-.02 1.245 0 .867-.021 1.324-.037 2.121-.001.038-.015.298.023.182.094-.28.188-.542.266-.745.049-.125.241-.614.359-.859.114-.234.211-.369.415-.688.2-.313.415-.448.668-.561.54-.235 1.109.112 1.301.591.086.215.009.713-.028 1.105-.061.647-.254 1.306-.352 1.648-.128.447-.274 1.235-.34 1.601-.072.394-.234 1.382-.359 1.82-.086.301-.371.978-.652 1.384 0 0-1.074 1.25-1.192 1.812-.117.563-.078.567-.101.965-.024.399.121.923.121.923s-.802.104-1.234.034c-.391-.062-.875-.841-1-1.078-.172-.328-.539-.265-.682-.023-.225.383-.709 1.07-1.051 1.113-.668.084-2.054.03-3.139.02 0 0 .185-1.011-.227-1.358-.305-.26-.83-.784-1.144-1.06l-.832-.921c-.284-.36-.629-1.093-1.243-1.985-.348-.504-1.027-1.085-1.284-1.579-.223-.425-.331-.954-.19-1.325.225-.594.675-.897 1.362-.832.519.05.848.206 1.238.537.225.19.573.534.75.748.163.195.203.276.377.509.23.307.302.459.214.121",fill:"#fff"}),L("g",{stroke:"#000",strokeLinecap:"round",strokeWidth:".75",children:[i("path",{d:"m4.5557 8.5742c-.098-.375-.196-.847-.406-1.552-.167-.557-.342-.859-.47-1.233-.155-.455-.303-.721-.496-1.181-.139-.329-.364-1.048-.457-1.44-.119-.509.033-.924.244-1.206.253-.339.962-.49 1.357-.351.371.13.744.512.916.788.288.46.357.632.717 1.542.393.992.564 1.918.611 2.231l.085.452c-.001-.04-.043-1.122-.044-1.162-.035-1.029-.06-1.823-.038-2.939.002-.126.064-.587.084-.715.078-.5.305-.8.673-.979.412-.201.926-.215 1.401-.017.423.173.626.55.687 1.022.014.109.094.987.093 1.107-.013 1.025.006 1.641.015 2.174.004.231.003 1.625.017 1.469.061-.656.094-3.189.344-3.942.144-.433.405-.746.794-.929.431-.203 1.113-.07 1.404.243.285.305.446.692.482 1.153.032.405-.019.897-.02 1.245 0 .867-.021 1.324-.037 2.121-.001.038-.015.298.023.182.094-.28.188-.542.266-.745.049-.125.241-.614.359-.859.114-.234.211-.369.415-.688.2-.313.415-.448.668-.561.54-.235 1.109.112 1.301.591.086.215.009.713-.028 1.105-.061.647-.254 1.306-.352 1.648-.128.447-.274 1.235-.34 1.601-.072.394-.234 1.382-.359 1.82-.086.301-.371.978-.652 1.384 0 0-1.074 1.25-1.192 1.812-.117.563-.078.567-.101.965-.024.399.121.923.121.923s-.802.104-1.234.034c-.391-.062-.875-.841-1-1.078-.172-.328-.539-.265-.682-.023-.225.383-.709 1.07-1.051 1.113-.668.084-2.054.03-3.139.02 0 0 .185-1.011-.227-1.358-.305-.26-.83-.784-1.144-1.06l-.832-.921c-.284-.36-.629-1.093-1.243-1.985-.348-.504-1.027-1.085-1.284-1.579-.223-.425-.331-.954-.19-1.325.225-.594.675-.897 1.362-.832.519.05.848.206 1.238.537.225.19.573.534.75.748.163.195.203.276.377.509.23.307.302.459.214.121",strokeLinejoin:"round"}),i("path",{d:"m11.566 12.734v-3.459"}),i("path",{d:"m9.551 12.746-.016-3.473"}),i("path",{d:"m7.555 9.305.021 3.426"})]})]})})}function up(){return i("svg",{width:"30",height:"30",viewBox:"0 0 32 32",fill:"none",children:L("g",{transform:"translate(8 9)",children:[i("path",{d:"m3.44281398 1.68449726c-.74326136.27630142-1.05584685.8131257-1.07636853 1.38003696-.01344897.37336893.06665513.72649286.23114214 1.18694303-.02596219-.07267623.09676488.29282004.12116236.37362273.05052942.16918921-.4865367-.05865774-.81377307.00741883-.36363321.07113868-.84783757.38332307-1.10006887.79754775-.29643467.48542737-.3109609 1.04368567-.08235979 2.04824266.12491868.54736183.36572145 1.00836814.71076689 1.44594879.15329951.1944118.5713628.64726015.60307236.6875974l.84854343.94062339c.15080214.1358526.25794954.2361946.57590427.5380259.3147558.2987762.4647038.4380078.60308951.555976.05846214.0492474.10784267.1797116.12740685.3736249.01609788.1595565.01049553.3375341-.0090192.5090254-.00674888.0593077-.01325791.1020883-.01698742.1224696-.04189161.228932.13269563.4403386.36541902.4424835.21585671.0019894.38528595.0046546.82216479.0123538.09483476.0016698.09483476.0016698.18993053.0033129 1.16876447.0200186 1.75308289.0147904 2.17807912-.0385723.45429894-.0572869.92650915-.6110188 1.32698393-1.2957591.34289141.6108338.81859723 1.2057867 1.2995685 1.2820532.1510118.0244148.3353555.0322555.548787.0275887.1606725-.0035131.3307029-.0140241.5021961-.0293376.1276907-.0114022.2293359-.0228648.29003-.0307451.2258836-.0293282.373669-.251611.3133108-.4712481-.0130351-.0474332-.0339838-.1345011-.0551094-.2441635-.0245945-.1276687-.0423383-.2523857-.0503381-.365988-.0050217-.0713101-.0059948-.1359317-.0027687-.1918983.0059157-.0980798.0077938-.1530073.0108033-.281125.0010795-.0448938.0010795-.0448938.0024606-.0845172.0054208-.1364475.0233824-.2649146.0815132-.544638.0250088-.1201275.1473169-.352189.3398902-.639435.0571394-.0852302.1195783-.1742239.1864664-.26609712.1272143-.17473362.2641361-.35131772.4011075-.52030772.082051-.10123129.145482-.17695689.1808122-.21807676.2967593-.42378347.612817-1.11823437.7291396-1.52536348.1117407-.39153936.202351-1.12501196.254373-1.81690429.029923-.39968605.0410555-.72381216.0410555-1.23011613.0000742-.09758414.0000742-.09758414.0002975-.17670236.0003569-.11115478.0003569-.11115478.000115-.20711835-.0008934-.15683883-.0055282-.31323355-.0207085-.69507578-.0313109-.81293139-.4771727-1.33911388-1.1344906-1.44058831-.559108-.08631314-1.0586051.08188477-1.2779293.31625977-.0755526.08073733.0036753-.2781823-.2159489-.62316278-.1644465-.25841586-.593184-.58905957-.9209287-.65355552-.335487-.06535532-.73539548-.05811715-1.1017193.00667481-.32093157.05742909-.68608434.33741751-.87176225.64688068-.12411885.20686477.03884667-.00592296-.09368743-.23401341-.18231052-.31422641-.60754287-.59486422-1.01411454-.67799709-.34643562-.07139428-.74182572-.04452925-1.09945614.0633873-.43336319.1291117-1.01795827.61460976-.94899189 1.15552627-.34375-.54091651-1.25026717-.691379-1.97906097-.42111797z",fill:"#000"}),i("path",{d:"m7.31951013 1.62138197c.20710357.04234751.44724204.20083012.51632974.31990811.08404358.1446387.15562749.36413806.21048667.6366124.02933373.14569467.12179446 1.2125285.29383112 1.32370243.41279229.04533731.41279229.04533731.52658055-.12364345.03545705-.07383858.03545705-.07383858.04226523-.1029106.01416796-.06009544.02463332-.12677987.0351322-.21754028l.00854738-.07915386.00047673-.00942804.00327525-.03167185c.01085148-.11424313.04184125-.4312127.05388392-.53034902.03788792-.31189663.08766449-.52757784.13944093-.6138719.0713024-.11883734.31942298-.28274442.43149612-.30279961.2804398-.04960082.58940103-.05519288.82623993-.00905543.1084394.02134018.3709471.22378689.432331.32024744.1291079.20279957.2524316.84889766.3225486 1.4970065-.0102194.04624251-.0102194.04624251.1640069.28984194.5843296-.06677889.5843296-.06677889.5703629-.17490247.0159511-.03856429.0284824-.08294031.045969-.15118961.0423876-.16089067.0697594-.25204451.111066-.35549917.0288558-.07227096.0592914-.13391873.0904889-.18278042.1209187-.19031132.4335712-.319392.7077174-.27707028.2943447.04543991.4816904.26653537.4994912.72869815.0148821.37434892.0193146.5239164.0201469.6700184l-.0004247.37954865c0 .48831141-.0104951.79388164-.0389535 1.17400348-.0480918.63962116-.1348512 1.34192123-.227649 1.66708484-.0946325.33121345-.3766371.95084197-.6003915 1.27298482-.0161892.01580846-.0841508.09694273-.1710333.20413492-.1445842.17838247-.2892181.36491271-.4247891.5511244-.0723398.09936149-.1402862.19620479-.2030964.2898938-.2440054.36396314-.400553.66098894-.4512157.90434304-.0659304.3172546-.0893838.4850003-.0966379.6675968-.0017072.0490782-.0017072.0490782-.002845.096677-.0028064.119476-.004437.1671639-.0097087.2545848-.0052654.091322-.0038193.187354.00332.2887353.0103318.1467182.1058713.3478531.1058713.3478531s-.2321503-.0119819-.3742084-.0088758c-.1718098.0037567-.3147843-.0023244-.4138162-.0183342-.1440353-.0228411-.53014068-.5057331-.7278511-.8821737-.30227042-.5764228-1.03604858-.5484427-1.33684295-.0394061-.26854779.4591613-.65918083.9172326-.7740684.9317199-.37404082.0469647-.94643778.0520862-2.07160079.0328144-.09480875-.0016381-.46003446-.0128683-.64600494-.0157445-.18597048-.0028763.05008807-.1790283.02786486-.399297-.03726222-.36933-.15125405-.6704984-.38877094-.8705429-.12241569-.1043631-.26774964-.2393104-.56509654-.5215613-.33323493-.3163366-.44236499-.4185353-.57290215-.533275l-.80130455-.89071892c-.03955779-.05174211-.45812831-.5051399-.5872217-.6688539-.28069963-.35597842-.47062947-.71959073-.56844755-1.14820437-.18921973-.83150113-.1793328-1.21146622-.00855589-1.49112273.13743587-.2257023.43815377-.4195862.60596039-.45241793.17165981-.03465512.55153059-.01648617.62179422.02229321.09902279.05401056.13357243.07300285.16379074.09097645.03572494.02124891.05965747.03799198.08182912.05708809.03426437.02951139.07235014.07170412.12420211.14044502.03611591.04821025.07806642.1053997.1423779.19304882.06054643.0816627.09183576.12069421.13369221.1590035.28038907.25662728.68391532.03238058.65052057-.32606956-.00567036-.06086415-.02203766-.12694598-.05458621-.23708502-.04356824-.15021272.00433013-.05284275-.26002629-.56642281-.08720664-.16942124-.13955864-.28835362-.17428227-.4046158l-.03412852-.10219113c-.03838756-.11059767-.09558223-.26854489-.12612861-.35199347l-.02009957-.05467087.002.008-.05974804-.17751191c-.09232236-.28807194-.13413567-.51358087-.12645475-.72681781.01040781-.28751553.16037753-.54506871.58790983-.70400047.40142488-.1488616 1.07786076.00117106 1.20581167.27856864.04319814.09369738.08927466.21199471.13900415.35457792l.03930997.11680217c.05539717.16759437.13470873.41493582.13860471.42816881.02724222.08344874.0471839.13860719.06943813.18441246.00217869.06301886.00217869.06301886.35429398.23177937.41699479-.29154152.41699479-.29154152.38019201-.37525838.00571063-.08773482.00758408-.17356287.00965287-.37317647.00242546-.23402898.00423842-.33154773.00994479-.45966208.01316411-.29554918.0437926-.51142116.09291227-.63864415.09160418-.23801371.25279279-.40993649.4432431-.46667832.24458613-.07380253.51465245-.09215236.73323569-.04710649zm1.21356228 4.27672201c-.20710459.00095412-.37422255.16961903-.37326843.37672361l.016 3.473c.00095412.20710459.16961903.37422251.37672361.37326841.20710459-.0009541.37422255-.16961901.37326843-.37672359l-.016-3.473c-.00095412-.20710459-.16961903-.37422255-.37672361-.37326843zm2.03332759.00229602c-.2071068 0-.375.16789322-.375.375v3.459c0 .20710678.1678932.375.375.375s.375-.16789322.375-.375v-3.459c0-.20710678-.1678932-.375-.375-.375zm-4.01399856.02930704c-.20710289.00126946-.37396385.17018863-.3726944.37729152l.021 3.426c.00126946.20710289.17018863.37396384.37729152.37269444.20710289-.0012695.37396385-.17018867.3726944-.37729156l-.021-3.426c-.00126946-.20710289-.17018863-.37396385-.37729152-.3726944z",fill:"#fff"})]})})}function ip(){return L("svg",{width:"16",height:"16",viewBox:"0 0 20 20",fill:"none",xmlns:"http://www.w3.org/2000/svg",children:[i("circle",{cx:"10",cy:"10",r:"8",stroke:"rgba(0,0,0,0.15)",strokeWidth:"2"}),i("path",{d:"M10 2A8 8 0 0 1 18 10",stroke:"black",strokeWidth:"2",strokeLinecap:"round"})]})}var tp="M0-8.4 2.55-3.65H-2.55ZM0 8.4 2.55 3.65H-2.55Z";function Ms({turn:e}){return i("svg",{width:"21",height:"21",viewBox:"-14 -14 28 28",overflow:"visible",children:L("g",{transform:`rotate(${e})`,strokeLinejoin:"round",children:[i("path",{d:tp,style:{fill:"var(--ss-cursor-edge, #fff)",stroke:"var(--ss-cursor-edge, #fff)"},strokeWidth:"3.2"}),i("path",{d:tp,style:{fill:"var(--ss-cursor-line, #000)",stroke:"var(--ss-cursor-line, #000)"},strokeWidth:"1.2"})]})})}var dp=()=>i(Ms,{turn:0}),fp=()=>i(Ms,{turn:90}),cp=()=>i(Ms,{turn:-45}),pp=()=>i(Ms,{turn:45});var mp=document.createElement("style");mp.textContent=`/* The cursor (cursor.tsx): glyphs, the five styles, press, idle, ripples. */

@layer stageshow {
  .ss-cursor {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 100;
    pointer-events: none;
    will-change: transform;
    transition: opacity 0.25s ease;
  }

  /* Sat still too long while the script plays: it steps out of the shot, and
     comes back the moment it moves */
  .ss-cursor[data-idle] {
    opacity: 0;
    transition-duration: 0.6s;
  }

  .ss-cursor__press {
    display: grid;
    /* The glyphs' hotspots meet at 0,0; pressing keeps that contact fixed. */
    transform-origin: 0 0;
    /* Lets go softly, as a finger lifting */
    transition: transform 0.26s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .ss-cursor[data-pressed="true"] .ss-cursor__press {
    transform: scale(0.9);
    transition: transform 0.08s ease-out;
  }

  .ss-cursor__glyph {
    grid-area: 1 / 1;
    transform: scale(0);
    opacity: 0;
    transition: transform 0.2s ease, opacity 0.2s ease;
  }

  .ss-cursor__glyph[data-active="true"] {
    transform: scale(var(--ss-cursor-size, 1));
    opacity: 1;
  }

  /* Into and out of a resize cursor, the arrow and the triangles cross over
     rather than pop: neither shrinks to nothing, and the ease is softer */
  .ss-cursor__glyph[data-glyph^="resize"] {
    transform: scale(calc(var(--ss-cursor-size, 1) * 0.5));
  }

  .ss-cursor[data-kind^="resize"] .ss-cursor__glyph:not([data-active="true"]) {
    transform: scale(calc(var(--ss-cursor-size, 1) * 0.6));
  }

  .ss-cursor[data-kind^="resize"] .ss-cursor__glyph,
  .ss-cursor__glyph[data-glyph^="resize"] {
    transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease;
  }

  .ss-cursor__glyph[data-glyph^="resize"][data-active="true"] {
    transform: scale(var(--ss-cursor-size, 1));
  }

  /* What it was leaves quickly, so no ghost of it trails the new shape */
  .ss-cursor[data-kind^="resize"] .ss-cursor__glyph:not([data-active="true"]),
  .ss-cursor:not([data-kind^="resize"]) .ss-cursor__glyph[data-glyph^="resize"] {
    transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.1s ease;
  }

  /* The open and closed hand are one hand: between them it closes and opens in
     place, and the press dip shows the grip, never one hand fading out as the
     other grows in */
  .ss-cursor:is([data-kind="open"], [data-kind="grab"]) .ss-cursor__glyph:is([data-glyph="open"], [data-glyph="grab"]) {
    transform: scale(var(--ss-cursor-size, 1));
    transition: opacity 0.08s linear;
  }

  .ss-cursor[data-style="large"] {
    --ss-cursor-size: 1.5;
  }

  /* The I-beam marks a text line, so it stays near the text's size */
  .ss-cursor[data-style="large"] .ss-cursor__glyph[data-glyph="ibeam"] {
    --ss-cursor-size: 1.15;
  }

  /* Gestural: a soft dot, no cursor kinds. Shrinks on press, fills while held. */
  .ss-cursor__dot {
    display: block;
    width: 22px;
    height: 22px;
    margin: -11px 0 0 -11px;
    /* Glass, like the iPadOS pointer: no outline, a translucent tint that
       blurs and lifts what's under it, a soft top highlight and a faint shadow.
       The blur goes while pressed (below): the dot then sits on the thing
       being pressed (a checkbox, a row's words) and a blur smears it */
    border-radius: 50%;
    background: rgba(118, 118, 128, 0.26);
    backdrop-filter: blur(5px) saturate(1.8) brightness(1.04);
    box-shadow:
      inset 0 1px 1px rgba(255, 255, 255, 0.4),
      inset 0 -1px 1px rgba(0, 0, 0, 0.05),
      0 2px 10px rgba(0, 0, 0, 0.1);
    transition: background 0.15s ease;
  }

  /* Over text the glass circle narrows into an I-beam bar, as the iPad pointer does */
  .ss-cursor__dot {
    transition: background 0.15s ease, width 0.2s cubic-bezier(0.22, 1, 0.36, 1), height 0.2s cubic-bezier(0.22, 1, 0.36, 1),
      margin 0.2s cubic-bezier(0.22, 1, 0.36, 1), border-radius 0.2s ease;
  }

  .ss-cursor[data-style="circle"][data-kind="ibeam"] .ss-cursor__dot {
    width: 4px;
    height: 20px;
    margin: -10px 0 0 -2px;
    border-radius: 2px;
    background: rgba(60, 60, 67, 0.55);
  }

  .ss-stage[data-theme='dark'] .ss-cursor__dot {
    background: rgba(255, 255, 255, 0.2);
    box-shadow:
      inset 0 1px 1px rgba(255, 255, 255, 0.3),
      0 2px 10px rgba(0, 0, 0, 0.3);
  }

  .ss-cursor[data-style="circle"][data-pressed="true"] .ss-cursor__press {
    transform: scale(0.8);
  }

  .ss-cursor[data-style="circle"][data-pressed="true"] .ss-cursor__dot {
    backdrop-filter: none;
    background: rgba(118, 118, 128, 0.22);
  }

  .ss-stage[data-theme='dark'] .ss-cursor[data-style="circle"][data-pressed="true"] .ss-cursor__dot {
    background: rgba(255, 255, 255, 0.18);
  }

  .ss-cursor[data-style="circle"][data-pressed="true"] .ss-cursor__dot,
  .ss-cursor[data-style="circle"][data-kind="grab"] .ss-cursor__dot {
    background: rgba(118, 118, 128, 0.4);
  }

  /* Touch: nothing between taps. A press lands a soft dot that fades as the
     finger lifts; a drag keeps it while held (the kind is grab then). */
  .ss-cursor[data-style="touch"] .ss-cursor__dot {
    width: 34px;
    height: 34px;
    margin: -17px 0 0 -17px;
    background: rgba(118, 118, 128, 0.14);
    /* A finger, not glass: no backdrop blur, which smears the checkbox or
       row it presses */
    backdrop-filter: none;
    /* Not there until it touches: the script shows it just before a press
       or a swipe and lets it go after the lift */
    opacity: 0;
    transform: scale(0.7);
    transition: opacity 0.4s ease, transform 0.45s cubic-bezier(0.22, 1, 0.36, 1);
  }

  /* The trail a finger leaves while it swipes: one soft streak from where
     it was a few frames ago to where it is, fading toward its tail. The
     script sizes and turns it each frame; it fades once the finger lifts */
  .ss-cursor__streak {
    position: absolute;
    left: 0;
    top: -13px;
    width: 0;
    height: 26px;
    border-radius: 13px;
    background: linear-gradient(to right, rgba(118, 118, 128, 0), rgba(118, 118, 128, 0.16));
    transform-origin: 100% 50%;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.16s ease;
  }

  .ss-cursor[data-swiping] .ss-cursor__streak {
    opacity: 1;
    transition: none;
  }

  .ss-cursor[data-style="touch"][data-touching] .ss-cursor__dot {
    opacity: 1;
    transform: scale(1);
    transition: opacity 0.14s ease, transform 0.16s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .ss-cursor[data-style="touch"][data-pressed="true"] .ss-cursor__dot,
  .ss-cursor[data-style="touch"][data-swiping] .ss-cursor__dot {
    background: rgba(118, 118, 128, 0.22);
    transform: scale(0.82);
    transition: background 0.08s ease, transform 0.1s ease-out;
  }

  .ss-cursor__glyph svg {
    display: block;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
  }

  /* Arrow cursor: one solid, rounded arrowhead */
  .ss-cursor__arrow path {
    fill: var(--ss-cursor-ink, #111);
    stroke: var(--ss-cursor-ink, #111);
    stroke-width: 2.4;
    stroke-linejoin: round;
  }

  .ss-cursor__arrow {
    display: block;
    filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.18));
  }

  .ss-stage[data-theme="dark"] .ss-cursor__arrow,
  .ss-stage[data-theme="blueprint"] .ss-cursor__arrow {
    --ss-cursor-ink: #fff;
  }

  /* Line cursors (I-beam, crosshair) invert on a dark surface, as macOS's do */
  .ss-stage[data-theme="dark"] .ss-cursor,
  .ss-stage[data-theme="blueprint"] .ss-cursor {
    --ss-cursor-line: #fff;
    --ss-cursor-edge: rgba(0, 0, 0, 0.75);
  }

  /* Ripple clicks: a ring spreads from the point and fades */
  .ss-ripple {
    position: absolute;
    z-index: 99;
    width: 36px;
    height: 36px;
    margin: -18px 0 0 -18px;
    border-radius: 50%;
    border: 1.5px solid var(--ss-accent);
    background: color-mix(in srgb, var(--ss-accent) 10%, transparent);
    pointer-events: none;
    animation: ss-ripple 0.55s cubic-bezier(0.25, 0.8, 0.25, 1) forwards;
  }

  @keyframes ss-ripple {
    from { transform: scale(0.2); opacity: 1; }
    to { transform: scale(1); opacity: 0; }
  }

  .ss-stage[data-palette="mono"] .ss-ripple {
    border-color: var(--ss-text-strong);
    background: transparent;
  }

  .ss-stage[data-hit] :is(.ss-cursor, .ss-cursor *) {
    pointer-events: none !important;
  }
}
`;document.head.appendChild(mp);var hp={pointer:np,ibeam:rp,crosshair:op,hand:sp,open:lp,grab:up,wait:ip,"resize-ns":dp,"resize-ew":fp,"resize-nwse":cp,"resize-nesw":pp},Vh={pointer:{x:7.5,y:5.25},ibeam:{x:5,y:8},crosshair:{x:8.5,y:8.5},hand:{x:9.75,y:3.25},open:{x:11.7,y:10.4},grab:{x:12,y:12},wait:{x:8,y:8},"resize-ns":{x:10.5,y:10.5},"resize-ew":{x:10.5,y:10.5},"resize-nwse":{x:10.5,y:10.5},"resize-nesw":{x:10.5,y:10.5}},Gh={x:4,y:3};function jh(){return i("svg",{width:"22",height:"22",viewBox:"0 0 22 22",className:"ss-cursor__arrow","aria-hidden":!0,children:i("path",{d:"M4 3 18.5 9.6 11.8 11.8 9.6 18.5Z"})})}function gp({cursorRef:e,style:a="real",kind:t}){return L("div",{ref:e,className:"ss-cursor","data-style":a,"data-kind":t,"aria-hidden":!0,children:[a==="touch"&&i("span",{className:"ss-cursor__streak"}),L("div",{className:"ss-cursor__press",children:[(a==="circle"||a==="touch")&&i("span",{className:"ss-cursor__dot"}),a!=="circle"&&a!=="touch"&&Object.keys(hp).map((n)=>{let r=a==="arrow";if(r&&n!=="pointer"&&n!=="ibeam")return null;let o=r&&n==="pointer"?jh:hp[n],s=r&&n==="pointer"?Gh:Vh[n];return i("div",{className:"ss-cursor__glyph","data-glyph":n,"data-active":n===(r&&t!=="ibeam"?"pointer":t),style:{marginLeft:-s.x,marginTop:-s.y,transformOrigin:`${s.x}px ${s.y}px`},children:i(o,{})},n)})]})]})}function xp(e,a){let t=document.createElement("span");t.className="ss-ripple",t.style.left=`${a.x}px`,t.style.top=`${a.y}px`,e.appendChild(t),t.addEventListener("animationend",()=>t.remove())}va();var ci=An({theme:"light",palette:"accent",fidelity:"standard",layout:"wide"}),pi=()=>_n(ci);va();var mi=An(!1);function Lp(){let e=_n(mi),[a,t]=ge(!1);return qa(()=>{let n=window.matchMedia("(prefers-reduced-motion: reduce)"),r=()=>t(n.matches);return r(),n.addEventListener("change",r),()=>n.removeEventListener("change",r)},[]),e||a}var pt={now:()=>performance.now(),raf:(e)=>requestAnimationFrame(e),cancelRaf:(e)=>cancelAnimationFrame(e),layoutRaf:(e)=>pt.recording?.requestLayoutFrame(e)??requestAnimationFrame(e),cancelLayoutRaf:(e)=>{let a=pt.recording;if(a)a.cancelLayoutFrame(e);else cancelAnimationFrame(e)},timeout:(e,a)=>window.setTimeout(e,a),clearTimeout:(e)=>window.clearTimeout(e),get recording(){return typeof window>"u"?null:window.__stageshow?.clock??null}};var Kh={};function As({width:e,height:a,initial:t=Kh,script:n,poster:r,cursor:o,hover:s,play:l="loop",compact:u,keys:c="bottom",palette:m="accent",greys:g,fidelity:h="standard",specimen:x,unframed:v,speed:k=1,accent:B,tokens:f,ground:d,fill:p=!1,theme:w="light",className:A,children:F}){let z=l==="hover"&&typeof window<"u"&&window.matchMedia("(hover: none)").matches?"once":l,[y,re]=ge("wide"),D=J(y);D.current=y;let K=()=>{let T=o.at;return typeof T==="object"&&"wide"in T?T[D.current]:T},[Ua,Bt]=ge(!1),Et=y==="compact"&&u?u.width:e,gt=y==="compact"&&u?u.height:a,ga=J(null),we=J(null),Xe=J(null),ra=Lp(),Ie=!n||ra,[b,S]=ge(()=>Ie&&r?r:t),I=J(b);I.current=b;let[P,M]=ge(1),O=J(1);O.current=P;let X=typeof window>"u"?{}:window.__stageshow??{},ue=k/(X.slow??1),E=X.theme??w,[N,ie]=ge(o?.kind??"pointer"),G=(T)=>{let U=we.current;if(!U||ra)return;xp(U,T)},fe=J(N);fe.current=N;let[Re,Ce]=ge({id:0,caps:[],show:!1,down:!1}),[Nt,V]=ge(null),ke=J(Re);ke.current=Re;let Z=J({x:0,y:0}),me=J(null),[Ot,kn]=ge(0),xa=J(!1),Ut=J(!1),to=J(null);sa(()=>{let T=ga.current;if(!T)return;let U=()=>{let Y=T.clientWidth,La=!!T.parentElement?.closest("[data-ss-wide]"),wa=u&&!La&&Y<u.below?"compact":"wide";re(wa);let Aa=p||!!T.parentElement?.closest("[data-ss-fill]");Bt(Aa);let ya=wa==="compact"?u.width:e,oa=Math.min(Aa?2:1,Y/ya);M(oa),kn(Math.max(0,(Y-ya*oa)/2))};U();let W=new ResizeObserver(U);W.observe(T);let H=new MutationObserver(U);for(let Y=T.parentElement;Y;Y=Y.parentElement)H.observe(Y,{attributes:!0,attributeFilter:["data-ss-wide","data-ss-fill"]});return()=>{W.disconnect(),H.disconnect()}},[e,u?.below,u?.width,p]);let[no,Ht]=ge({}),Bs=Ta(()=>{let T=we.current;if(!T)return{};let U={},W=T.querySelectorAll("[data-target]");if(!W.length)return U;let H=Ps(T,O.current);return W.forEach((Y)=>{U[Y.dataset.target]=$c(T,Y,O.current,H)}),U},[]),Es=J({n:0,frame:0,owed:!1}),xt=Ta(()=>{let T=Es.current;if(!T.frame)T.frame=pt.layoutRaf(()=>{if(T.n=0,T.frame=0,!T.owed)return;T.owed=!1;let W=Bs();Ht((H)=>di(H,W)?H:W)});if(T.n>=4){T.owed=!0;return}T.n++;let U=Bs();Ht((W)=>di(W,U)?W:U)},[Bs]);sa(xt),sa(()=>()=>{pt.cancelLayoutRaf(Es.current.frame),Es.current={n:0,frame:0,owed:!1}},[]),qa(()=>{let T=we.current;if(!T)return;return T.addEventListener("transitionend",xt),T.addEventListener("animationend",xt),()=>{T.removeEventListener("transitionend",xt),T.removeEventListener("animationend",xt)}},[xt]);let Wp=Ta((T)=>no[T]??ks,[no]),[Vp,gi]=ge(!0);sa(()=>{gi(!0);let T=!0,U=0,W=()=>{U=pt.layoutRaf(()=>{U=pt.layoutRaf(()=>T&&gi(!1))})};if(!document.fonts||document.fonts.status==="loaded")W();else document.fonts.ready.then(()=>T&&W());return()=>{T=!1,pt.cancelLayoutRaf(U)}},[y]);let qt=J(0),Sn=J(0),Pn=J(!1),Ns=J(null),Wt=Ta((T)=>{if(Sn.current&&!Pn.current&&Math.hypot(T.x-Z.current.x,T.y-Z.current.y)>0.5)Pn.current=!0,Ns.current??=performance.now()-Sn.current;Z.current=T,qt.current=performance.now();let U=Xe.current;if(!U)return;U.style.transform=`translate(${T.x}px, ${T.y}px)`,U.removeAttribute("data-idle")},[]),Lt=Ta((T)=>{if(typeof T==="object"&&T!==null&&"wide"in T)T=D.current==="compact"?T.compact:T.wide;let U=Ss(T);if(U===null)return T;let W=we.current,H=W?.querySelector(`[data-target="${U}"]`);if(!W||!H)return dt(`no element with data-target="${U}"`),Z.current;let Y=Dt(W,H,O.current),La=typeof T==="string"?{x:0.5,y:0.5}:T;return{x:Y.x+Y.width*La.x,y:Y.y+Y.height*La.y}},[]);sa(()=>{if(!Ie||!s)return;let T=we.current;s.forEach((U)=>T?.querySelector(`[data-target="${U}"]`)?.setAttribute("data-hover",""))}),sa(()=>{if(o&&!Sn.current)Wt(Lt(K()))},[P,y]);let Os=J(0),wt=J(0),ro=Ta(()=>{++Os.current,cancelAnimationFrame(wt.current),wt.current=0,we.current?.removeAttribute("data-settling")},[]),Us=Ta((T=!1)=>{ro();let U=Os.current;if(Ut.current=!1,S(t),ie(o?.kind??"pointer"),Ce((H)=>({...H,show:!1,down:!1})),V(null),we.current?.querySelectorAll("[data-hover],[data-pressed]").forEach((H)=>{H.removeAttribute("data-hover"),H.removeAttribute("data-pressed")}),we.current?.removeAttribute("data-mark"),we.current?.querySelectorAll("[data-scrolled]").forEach((H)=>{H.scrollTop=0,H.removeAttribute("data-scrolled"),bs(H)}),we.current?.querySelectorAll("[data-scrolling]").forEach((H)=>H.removeAttribute("data-scrolling")),Xe.current?.removeAttribute("data-pressed"),to.current=null,!o)return;if(!T){wt.current=requestAnimationFrame(()=>{wt.current=0,Wt(Lt(K())),me.current?.(Z.current)});return}let W=we.current;W?.setAttribute("data-settling",""),wt.current=requestAnimationFrame(()=>{let H={...Z.current},Y=Lt(K()),La=ft(320+Math.hypot(Y.x-H.x,Y.y-H.y)*0.7,380,700),wa=performance.now(),Aa=()=>{if(Os.current!==U)return;let ya=Math.min(1,(performance.now()-wa)/La),oa=In(ya);if(Wt({x:H.x+(Y.x-H.x)*oa,y:H.y+(Y.y-H.y)*oa}),ya<1)wt.current=requestAnimationFrame(Aa);else wt.current=0,W?.removeAttribute("data-settling")};Aa()})},[y]),xi=so(()=>(T)=>ep(T,{rootRef:we,cursorRef:Xe,pos:Z,hovered:to,kindRef:fe,keysRef:ke,dragging:Ut,autoUsed:xa,autoRef:me,scaleRef:O,speed:ue,layout:y,cursor:o,resolve:Lt,place:Wt,remeasure:xt,ripple:G,setState:S,setKind:ie,setKeys:Ce,setLastKeys:V}),[Lt,Wt,ue,y]);qa(()=>{let T=we.current;if(Ie||!n)return Us(),T.removeAttribute("data-offscreen"),S(r??t),ro;Us();let U=ga.current,W=null,H=!1,Y=!1,La=!1,wa=o?.idle??4000,Aa=1200,ya=0,oa=0,Kp=()=>{if(window.clearInterval(ya),!o||wa===!1)return;qt.current=performance.now(),ya=window.setInterval(()=>{let ce=Xe.current;if(!ce)return;let $e=performance.now();if(!Pn.current){if(Ns.current===null&&$e-qt.current>Aa)ce.setAttribute("data-idle","");return}if(ce.hasAttribute("data-pressed")||we.current?.querySelector("[data-hover]"))qt.current=$e;else if($e-qt.current>wa)ce.setAttribute("data-idle","")},150)},Xp=()=>{Sn.current=performance.now(),Pn.current=!1,window.clearTimeout(oa);let ce=Xe.current,$e=Ns.current;if(wa===!1||!ce||$e===null||$e<=Aa)return;ce.setAttribute("data-idle",""),oa=window.setTimeout(()=>ce.removeAttribute("data-idle"),$e-400)},Hs=()=>{window.clearInterval(ya),window.clearTimeout(oa),Sn.current=0,Xe.current?.removeAttribute("data-idle")},$p=()=>{window.clearInterval(ya),window.clearTimeout(oa);let ce=Xe.current,$e=()=>ce?.hasAttribute("data-pressed")||T.querySelector("[data-hover]");if(!o||wa===!1||!ce||ce.hasAttribute("data-idle")||$e())return;let oo=(Pn.current?wa:Aa)-(performance.now()-qt.current);oa=window.setTimeout(()=>{if(!$e())ce.setAttribute("data-idle","")},Math.max(0,oo))},qs=()=>{if(W||La||!H||document.hidden)return;if(z==="hover"&&!Y)return;if(ro(),o)Wt(Lt(K()));W=new AbortController;let ce=W.signal;Kp();let $e=xi(ce);(async()=>{do{Xp();try{await n($e)}catch(oo){if(oo instanceof ct)return;console.error("[stageshow] script error",oo),W=null,Hs();return}if(z==="loop"&&fi())ap(I.current,t,Z.current,o?Lt(K()):null)}while(z==="loop"&&!ce.aborted);if(z==="once"&&!ce.aborted)La=!0,$p()})()},Ws=(ce=!1)=>{if(Hs(),!W)return;if(W.abort(),W=null,!La)Us(ce)},Vs=()=>T.toggleAttribute("data-offscreen",!H||document.hidden);Vs();let Li=new IntersectionObserver(([ce])=>{H=ce.isIntersecting,Vs(),H?qs():Ws()});Li.observe(U);let wi=()=>{Vs(),document.hidden?Ws():qs()};document.addEventListener("visibilitychange",wi);let yi=()=>{Y=!0,qs()},vi=()=>{Y=!1,Ws(!0)};if(z==="hover")U.addEventListener("pointerenter",yi),U.addEventListener("pointerleave",vi);return()=>{Li.disconnect(),document.removeEventListener("visibilitychange",wi),U.removeEventListener("pointerenter",yi),U.removeEventListener("pointerleave",vi),Hs(),W?.abort(),W=null,me.current=null,ro()}},[Ie,n,xi,z,y]),sa(()=>{if(o&&!Ie&&!Ut.current)me.current?.(Z.current)},[b]);let Gp=so(()=>({theme:E,palette:m,fidelity:h,layout:y}),[E,m,h,y]),jp=o&&(!n||!Ie||o.still);return i("div",{ref:ga,className:`ss-fit${A?` ${A}`:""}`,style:{maxWidth:Ua?void 0:e,height:gt*P},children:L("div",{ref:we,className:"ss-stage","data-specimen":x||void 0,"data-unframed":v||void 0,"data-still":Ie||void 0,"data-placing":Vp||void 0,"data-theme":E,"data-palette":m,"data-greys":g==="cool"?"cool":void 0,"data-fidelity":h,"data-layout":y,style:{width:Et,height:gt,marginLeft:Ot||void 0,transform:`scale(${P})`,...f,...B?{["--ss-accent"]:B,["--ss-accent-2"]:B,["--ss-accent-soft"]:`color-mix(in srgb, ${B} 14%, transparent)`}:null},children:[d&&i("div",{className:"ss-ground","aria-hidden":!0,style:Array.isArray(d)?{["--ss-orb-1"]:d[0],["--ss-orb-2"]:d[1],...d[2]?{["--ss-orb-3"]:d[2]}:null}:void 0}),i(mi.Provider,{value:Ie,children:i(ci.Provider,{value:Gp,children:F(b,Wp,y)})}),n&&i(Kc,{rows:[Nt,Re],at:typeof c==="string"?c:c[y]}),jp&&i(gp,{cursorRef:Xe,style:o.style,kind:N})]})})}var wp=document.createElement("style");wp.textContent=`/* Window chrome (window.tsx): browser, app and sidebar app, plus the Bar and
   Text placeholders. */

@layer stageshow {
  /* Drawn: lights and fields are outlines, not fills */
  .ss-stage[data-theme="blueprint"] .ss-window__dot {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--ss-line);
  }

  .ss-stage[data-theme="blueprint"] .ss-window__url {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--ss-line-faint);
  }

  /* Traffic lights go gray too */
  .ss-stage[data-palette="mono"] .ss-window__dot {
    background: var(--ss-ink-5);
    box-shadow: none;
  }

  :where(.ss-window) {
    position: relative;
    /* Where the lights sit: their center's distance from the window's top
       (and from its left edge), their size, and the floating sidebar's
       inset. lightsSize, barSize and sidebarStyle set these */
    --ss-lights-y: 19px;
    --ss-dot: 9px;
    --ss-side-inset: 0px;
  }

  .ss-window {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--ss-canvas);
    border-radius: var(--ss-radius-window);
    box-shadow: var(--ss-shadow-window);
  }

  .ss-window__bar {
    /* A fixed height, so the traffic lights sit in the same place whether the
       bar holds an address, a title or nothing. */
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 6px;
    height: 38px;
    /* The lights sit as far from the left edge as from the top: (38 - 9) / 2 */
    padding: 0 calc(var(--ss-lights-y) - var(--ss-dot) / 2);
    background: var(--ss-chrome);
    border-bottom: 1px solid var(--ss-line);
  }

  .ss-window__lights {
    display: flex;
    flex-shrink: 0;
    /* macOS proportions: 12pt lights, 8pt apart */
    gap: 6px;
  }

  .ss-window__dot {
    width: var(--ss-dot);
    height: var(--ss-dot);
    border-radius: 50%;
    box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.12);
  }

  .ss-window__dot:nth-child(1) { background: #ff5f57; }

  .ss-window__dot:nth-child(2) { background: #febc2e; }

  .ss-window__dot:nth-child(3) { background: #28c840; }

  .ss-window__url {
    flex: 1;
    min-width: 0;
    margin-left: 8px;
    padding: 4px 10px;
    overflow: hidden;
    background: var(--ss-ink-1);
    border-radius: 6px;
    /* Chrome type is the browser's, never the page's: small and quiet, whatever
       size the page inside sets */
    color: var(--ss-text-faint);
    font-size: 10.5px;
    line-height: 1.4;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  /* urlShape="pill": the round address field of current Safari and Chrome */
  .ss-window[data-url-shape="pill"] .ss-window__url {
    padding-inline: 12px;
    border-radius: 999px;
  }

  .ss-window__title {
    flex: 1;
    /* Optically centered: offsets the three dots on the left */
    margin-right: 36px;
    text-align: center;
    font-size: 13px;
    font-weight: 600;
    color: var(--ss-text-strong);
  }

  .ss-window__body {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  .ss-window__spacer {
    flex: 1;
  }

  /* lights="grey": quiet lights for any chrome */
  .ss-window[data-lights="grey"] .ss-window__dot {
    background: rgba(186, 200, 218, 0.5);
    box-shadow: none;
  }

  /* lights="white": translucent white lights remain distinct over a strong
     color field, where gray lights can lose contrast. */
  .ss-window[data-lights="white"] .ss-window__dot {
    background: rgba(255, 255, 255, 0.5);
    box-shadow: none;
  }

  /* chrome="glass": a frosted frame that takes
     the color behind it, no bar fill or rule, the address centered on the
     window, and the page a white card inset in the frame. Nested radii: the
     frame's 12 is the card's 6 plus the 6 inset */
  .ss-window[data-chrome="glass"] {
    background: rgba(248, 250, 253, 0.45);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    border-radius: 12px;
    box-shadow:
      0 0 0 1px rgba(229, 237, 245, 0.5),
      0 15px 35px rgba(23, 23, 23, 0.08);
  }

  .ss-window[data-chrome="glass"] > .ss-window__bar {
    display: grid;
    grid-template-columns: 1fr minmax(0, 262px) 1fr;
    gap: 12px;
    height: 35px;
    padding: 0 20px;
    background: none;
    border: 0;
  }

  .ss-window[data-chrome="glass"] .ss-window__lights {
    gap: 4px;
  }

  .ss-window[data-chrome="glass"] .ss-window__dot {
    width: 8px;
    height: 8px;
  }

  .ss-window[data-chrome="glass"] .ss-window__url {
    display: flex;
    grid-column: 2;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 20px;
    margin: 0;
    padding: 0 8px;
    background: rgba(255, 255, 255, 0.38);
    border-radius: 999px;
    box-shadow: inset 0 0 0 1px rgba(229, 237, 245, 0.5);
    color: #50617a;
    font-size: 10px;
  }

  .ss-window__lock {
    flex-shrink: 0;
    color: #667691;
  }

  .ss-window__url-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ss-window[data-chrome="glass"] .ss-window__end {
    display: flex;
    grid-column: 3;
    justify-content: flex-end;
    gap: 6px;
  }

  /* The page is white, not the canvas tone: the step from frosted frame to
     clean white page is what draws the card */
  .ss-window[data-chrome="glass"] > .ss-window__body {
    margin: 0 6px 6px;
    overflow: hidden;
    background: #fff;
    border-radius: 6px;
    box-shadow: 0 3px 6px rgba(23, 23, 23, 0.06);
  }

  /* chrome="card": one white card. Pale dots and a wide pale address bar,
     no bar fill and no rule, so the page runs straight up into the chrome;
     the long, soft shadow lifts it */
  .ss-window[data-chrome="card"] {
    background: #fff;
    border-radius: 8px;
    box-shadow:
      0 50px 100px -20px rgba(50, 50, 93, 0.25),
      0 30px 60px -30px rgba(0, 0, 0, 0.3);
  }

  .ss-window[data-chrome="card"] > .ss-window__bar {
    gap: 14px;
    height: 44px;
    padding: 0 16px;
    background: none;
    border: 0;
  }

  .ss-window[data-chrome="card"]:not([data-lights="color"]) .ss-window__dot {
    background: #ecf2f7;
    box-shadow: none;
  }

  .ss-window[data-chrome="card"] .ss-window__url {
    flex: 1;
    height: 24px;
    margin: 0;
    padding: 0 10px;
    background: #ecf2f7;
    border-radius: 4px;
    box-shadow: none;
    color: #425466;
    font-size: 12px;
    font-weight: 300;
    line-height: 24px;
  }

  .ss-window[data-chrome="card"] .ss-window__end:empty {
    display: none;
  }

  .ss-window[data-chrome="card"] > .ss-window__body {
    background: #fff;
  }

  /* chrome="hairline": a short bar over a 1px rule, tiny dots, the address
     as bare centered text */
  .ss-window[data-chrome="hairline"] {
    background: #fff;
    border-radius: 8px;
    box-shadow:
      0 0 0 1px rgba(0, 0, 0, 0.06),
      0 12px 28px -12px rgba(50, 50, 93, 0.2);
  }

  .ss-window[data-chrome="hairline"] > .ss-window__bar {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    height: 20px;
    padding: 0 8px;
    background: none;
    border: 0;
    border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  }

  .ss-window[data-chrome="hairline"] .ss-window__lights {
    gap: 3px;
  }

  .ss-window[data-chrome="hairline"] .ss-window__dot {
    width: 5px;
    height: 5px;
  }

  .ss-window[data-chrome="hairline"]:not([data-lights="color"]) .ss-window__dot {
    background: #e3e8ee;
    box-shadow: none;
  }

  .ss-window[data-chrome="hairline"] .ss-window__url {
    grid-column: 2;
    height: auto;
    margin: 0;
    padding: 0;
    background: none;
    box-shadow: none;
    color: #8792a2;
    font-size: 9px;
  }

  .ss-window[data-chrome="hairline"] .ss-window__end {
    grid-column: 3;
    justify-self: end;
  }

  /* chrome="terminal": one dark surface. The bar is the same color as the
     body with no rule, the title dim and centered on the window; a hairline
     light edge keeps the frame from melting into a dark stage */
  .ss-window[data-chrome="terminal"] {
    --ss-term-bg: #17171a;
    background: var(--ss-term-bg);
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.07),
      var(--ss-shadow-hero, var(--ss-shadow-window));
  }

  .ss-window[data-chrome="terminal"] > .ss-window__bar {
    position: relative;
    background: none;
    border: 0;
  }

  .ss-window[data-chrome="terminal"][data-lights="grey"] .ss-window__dot {
    background: rgba(255, 255, 255, 0.16);
    box-shadow: none;
  }

  .ss-term__title {
    position: absolute;
    left: 50%;
    translate: -50% 0;
    color: rgba(255, 255, 255, 0.42);
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
  }

  /* Mono at a size that reads, lines with room: output a step dimmer than
     what was typed, so the command is what the eye finds */
  .ss-term {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 4px 16px 16px;
    overflow: hidden;
    color: #9d9da6;
    font: 11.5px/1.65 var(--ss-mono);
    font-variant-ligatures: none;
  }

  .ss-term > * + .ss-term__prompt {
    margin-top: 8px;
  }

  .ss-term__line,
  .ss-term > div,
  .ss-term > p {
    margin: 0;
    white-space: pre;
  }

  /* Terminal colors are tokens with these defaults: set --ss-term-path,
     --ss-term-sigil, --ss-term-ok, --ss-term-err or --ss-term-dim on the
     window (or any parent) to match a product's accent */
  .ss-term__path {
    color: var(--ss-term-path, #6f8ccf);
  }

  .ss-term__sigil {
    margin: 0 7px;
    color: var(--ss-term-sigil, #6ee7a8);
  }

  .ss-term__cmd {
    color: #f1f1f3;
  }

  /* Status color, sparingly: a pass, a failure, a dim aside */
  .ss-term .ok { color: var(--ss-term-ok, #6ee7a8); }
  .ss-term .err { color: var(--ss-term-err, #f87171); }
  .ss-term .dim { color: var(--ss-term-dim, #63636b); }

  .ss-term__caret {
    display: inline-block;
    width: 0.6em;
    height: 1.2em;
    margin-left: 1px;
    vertical-align: -0.22em;
    background: #e8e8ec;
    animation: ss-term-blink 1.06s steps(1) infinite;
  }

  .ss-term__caret[data-still] {
    animation: none;
  }

  @keyframes ss-term-blink {
    50% { opacity: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ss-term__caret { animation: none; }
  }

  /* With toolbar controls the bar becomes a unified toolbar, as in Notes or
     Finder: the title goes left beside the lights and the controls go right. */
  .ss-window__title[data-toolbar] {
    margin: 0 0 0 14px;
    text-align: left;
  }

  .ss-window__nav {
    display: flex;
    flex-shrink: 0;
    gap: 6px;
    margin-left: 10px;
    color: var(--ss-text-faint);
  }

  .ss-window__nav + .ss-window__url {
    margin-left: 4px;
  }

  /* Browser with tabs: the strip holds the lights at the same 38px height; the
     active tab is the toolbar's color and joins it, the strip sits a step back. */
  .ss-window__tabs {
    display: flex;
    flex-shrink: 0;
    align-items: flex-end;
    gap: 2px;
    height: 38px;
    padding: 0 calc(var(--ss-lights-y) - var(--ss-dot) / 2);
    background: var(--ss-canvas);
  }

  .ss-window__tabs .ss-window__lights {
    align-self: center;
    margin-right: 14px;
  }

  .ss-window__tab {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 140px;
    min-width: 0;
    height: 30px;
    padding: 0 12px;
    border-radius: 8px 8px 0 0;
    font-size: 11px;
    color: var(--ss-text-faint);
  }

  .ss-window__tab[data-active] {
    background: var(--ss-chrome);
    color: var(--ss-text-strong);
  }

  .ss-window__tab-label {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .ss-window__favicon {
    flex-shrink: 0;
    width: 10px;
    height: 10px;
    border-radius: 3px;
    background: var(--ss-ink-4);
  }

  .ss-window__tab[data-active] .ss-window__favicon {
    background: var(--ss-accent);
  }

  [data-kind="tabs"] > .ss-window__bar .ss-window__url {
    margin-left: 0;
  }

  [data-kind="tabs"] > .ss-window__bar .ss-window__nav {
    margin-left: 0;
  }

  /* Sidebar app: the sidebar runs the full height, the lights sit in its top
     38px at the same spot as every other chrome, and the content column has
     its own bar with a left-aligned title. */
  .ss-window[data-kind="sidebar"] {
    flex-direction: row;
  }

  .ss-window__side {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    background: var(--ss-canvas);
    border-right: 1px solid var(--ss-line);
  }

  .ss-window__side-top {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    /* Centers the lights --ss-lights-y down from the window's top, as far in
       from its left edge, inside a floating panel too */
    height: calc((var(--ss-lights-y) - var(--ss-side-inset)) * 2);
    padding: 0 calc(var(--ss-lights-y) - var(--ss-side-inset) - var(--ss-dot) / 2);
  }

  .ss-window__main {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    background: var(--ss-surface);
  }

  .ss-window__main > .ss-window__bar {
    padding: 0 16px;
  }

  .ss-window__heading {
    font-size: 13px;
    font-weight: 600;
    color: var(--ss-text-strong);
  }

  .ss-bar {
    display: block;
    flex-shrink: 0;
  }

  /* A line gives way in a row too narrow for it, never past its container
     (Bar shrink, on by default for lines). Where it fits, nothing changes */
  .ss-bar[data-shrink] {
    flex-shrink: 1;
    min-width: 0;
    max-width: 100%;
  }

  /* lightsSize="large": macOS 26's 12pt lights, 8pt apart */
  .ss-window[data-lights-size="large"] {
    --ss-dot: 12px;
  }

  .ss-window[data-lights-size="large"] .ss-window__lights {
    gap: 8px;
  }

  /* barSize="tall": a 64px icon-and-label toolbar with no fill or rule.
     Controls are 32px at the top, so they center 26px down, with their
     labels under them; the lights and the title sit level with them */
  .ss-window[data-bar="tall"] {
    --ss-lights-y: 26px;
  }

  .ss-window[data-bar="tall"] > .ss-window__bar,
  .ss-window[data-bar="tall"] .ss-window__main > .ss-window__bar {
    align-items: flex-start;
    height: 64px;
    padding-top: 10px;
    background: none;
    border-bottom: 0;
  }

  .ss-window[data-bar="tall"] > .ss-window__bar > .ss-window__lights {
    margin-top: calc(16px - var(--ss-dot) / 2);
  }

  /* The address field is shorter than a control: center it on their row */
  .ss-window[data-bar="tall"] .ss-window__url {
    margin-top: 5px;
  }

  .ss-window[data-bar="tall"] .ss-window__title,
  .ss-window[data-bar="tall"] .ss-window__heading {
    line-height: 32px;
  }

  /* sidebarStyle="floating": macOS 26's sidebar, a rounded panel inset on
     the top, left and bottom with a faint edge and shadow. Nested radii: the
     window's 24 is the panel's 16 plus the 8 inset */
  .ss-window[data-side="floating"] {
    --ss-side-inset: 8px;
    border-radius: 24px;
    background: var(--ss-surface);
  }

  .ss-window[data-side="floating"] > .ss-window__side {
    position: relative;
    z-index: 1;
    margin: var(--ss-side-inset) 0 var(--ss-side-inset) var(--ss-side-inset);
    border-right: 0;
    border-radius: 16px;
    box-shadow:
      0 0 0 0.5px rgba(0, 0, 0, 0.07),
      inset 0 0.5px 0 rgba(255, 255, 255, 1),
      0 3px 14px rgba(20, 35, 70, 0.07);
  }

  .ss-stage[data-theme="dark"] .ss-window[data-side="floating"] > .ss-window__side {
    background: var(--ss-raised);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.08),
      0 3px 14px rgba(0, 0, 0, 0.3);
  }

  .ss-text {
    white-space: nowrap;
  }

  .ss-text[data-wrap] {
    white-space: normal;
  }
}
`;document.head.appendChild(wp);function Pr(){return L("span",{className:"ss-window__lights",children:[i("span",{className:"ss-window__dot"}),i("span",{className:"ss-window__dot"}),i("span",{className:"ss-window__dot"})]})}function Xh(){return L("svg",{className:"ss-window__lock",width:"7",height:"8",viewBox:"0 0 7 8","aria-hidden":!0,children:[i("path",{d:"M1.5 3.3V2.4a2 2 0 0 1 4 0v.9",fill:"none",stroke:"currentColor",strokeWidth:"1.1"}),i("rect",{x:"0",y:"3.3",width:"7",height:"4.7",rx:"1.2",fill:"currentColor"})]})}function yp({back:e}){return i("svg",{className:"ss-window__chev",width:"10",height:"10",viewBox:"0 0 10 10","aria-hidden":!0,children:i("path",{d:e?"M6.5 1.5 3 5l3.5 3.5":"M3.5 1.5 7 5 3.5 8.5",fill:"none",stroke:"currentColor",strokeWidth:"1.4",strokeLinecap:"round",strokeLinejoin:"round"})})}function vp({url:e,urlShape:a,tabs:t,nav:n,title:r,sidebar:o,sidebarWidth:s=180,sidebarStyle:l,toolbar:u,lead:c,body:m,className:g,receded:h,chrome:x,lights:v,lightsSize:k,barSize:B,children:f,...d}){let p=`ss-window ss-recede${g?` ${g}`:""}`,w=k==="large"?"large":void 0,A=B==="tall"?"tall":void 0;if(x==="terminal")return L("div",{...d,className:p,"data-chrome":"terminal","data-lights":v==="grey"?"grey":void 0,"data-lights-size":w,"data-receded":h||void 0,children:[L("div",{className:"ss-window__bar",children:[i(Pr,{}),r!==void 0&&i("span",{className:"ss-term__title",children:r})]}),i("div",{...m,className:`ss-window__body ss-term${m?.className?` ${m.className}`:""}`,children:f})]});if(x==="glass"||x==="card"||x==="hairline")return L("div",{...d,className:p,"data-chrome":x,"data-lights":v==="color"||v==="white"?v:x==="glass"?"grey":void 0,"data-receded":h||void 0,children:[L("div",{className:"ss-window__bar",children:[i(Pr,{}),e!==void 0&&L("span",{className:"ss-window__url",children:[x==="glass"&&i(Xh,{}),i("span",{className:"ss-window__url-text",children:e})]}),i("span",{className:"ss-window__end",children:u})]}),i("div",{...m,className:`ss-window__body${m?.className?` ${m.className}`:""}`,children:f})]});let F=e!==void 0&&L(Ma,{children:[n&&L("span",{className:"ss-window__nav",children:[i(yp,{back:!0}),i(yp,{})]}),i("span",{className:"ss-window__url",children:e})]});if(o!==void 0)return L("div",{...d,className:p,"data-kind":"sidebar","data-side":l==="floating"?"floating":void 0,"data-lights":v==="grey"?"grey":void 0,"data-lights-size":w,"data-bar":A,"data-receded":h||void 0,"data-url-shape":a,children:[L("aside",{className:"ss-window__side",style:{width:s},children:[i("div",{className:"ss-window__side-top",children:i(Pr,{})}),o]}),L("div",{className:"ss-window__main",children:[L("div",{className:"ss-window__bar",children:[r!==void 0&&i("span",{className:"ss-window__heading",children:r}),c,F,i("span",{className:"ss-window__spacer"}),u]}),i("div",{...m,className:`ss-window__body${m?.className?` ${m.className}`:""}`,children:f})]})]});if(t?.length)return L("div",{...d,className:p,"data-kind":"tabs","data-lights":v==="grey"?"grey":void 0,"data-lights-size":w,"data-receded":h||void 0,"data-url-shape":a,children:[L("div",{className:"ss-window__tabs",children:[i(Pr,{}),t.map((z,y)=>L("span",{className:"ss-window__tab","data-active":y===0||void 0,children:[i("span",{className:"ss-window__favicon"}),i("span",{className:"ss-window__tab-label",children:z})]},y))]}),L("div",{className:"ss-window__bar",children:[F,u]}),i("div",{...m,className:`ss-window__body${m?.className?` ${m.className}`:""}`,children:f})]});return L("div",{...d,className:p,"data-receded":h||void 0,"data-url-shape":a,"data-lights":v==="grey"?"grey":void 0,"data-lights-size":w,"data-bar":A,children:[L("div",{className:"ss-window__bar",children:[i(Pr,{}),F,r!==void 0&&i("span",{className:"ss-window__title","data-toolbar":u?!0:void 0,children:r}),c,e===void 0&&r===void 0&&i("span",{className:"ss-window__spacer"}),u]}),i("div",{...m,className:`ss-window__body${m?.className?` ${m.className}`:""}`,children:f})]})}var $h=["var(--ss-ink-1)","var(--ss-ink-2)","var(--ss-ink-3)","var(--ss-ink-4)","var(--ss-ink-5)"];function na({w:e,h:a=6,tone:t=3,r:n=2,shrink:r,className:o,style:s,...l}){let u=r??(typeof e==="number"&&e>a*3);return i("span",{...l,className:`ss-bar${o?` ${o}`:""}`,"data-shrink":u||void 0,style:{width:e,height:a,borderRadius:n,background:$h[t-1],...s}})}va();var Ip=document.createElement("style");Ip.textContent=`/* Collapse */

@layer stageshow {
  /* The space and the content move together, so there's never an empty band
     where a row was or is about to be. Closing, the content dims fast (to a
     third in the first 100ms, before the closing edge reaches it) and then
     dissolves over the rest of the height's travel, so it is faint while
     the edge passes and still there while the space closes: the fade and
     the height overlap to the end and no empty box is shown. A fade that
     finished before the height had moved left a blank band for about 100ms.
     Opening, the content comes in as the edge passes it. No mask, so no
     gradient wash. */
  .ss-collapse {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition: grid-template-rows 0.42s cubic-bezier(0.4, 0, 0.2, 1) 0.05s, opacity 0.42s cubic-bezier(0, 0.8, 0.5, 1);
  }

  .ss-collapse[data-open] {
    grid-template-rows: 1fr;
    opacity: 1;
    transition: grid-template-rows 0.46s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.24s ease-out 0.15s;
  }

  /* solid: a surface unlike the ground opens and closes without fading
     (a dark panel would pass through gray); only the height moves */
  .ss-collapse[data-solid],
  .ss-collapse[data-solid][data-open] {
    opacity: 1;
  }

  .ss-collapse__inner {
    min-height: 0;
    overflow: clip;
    overflow-clip-margin: 3px;
  }

  /* A clip reveal unfolds from the content's middle line: the space clips it
     equally above and below, so a row's text (in its middle) is whole by about
     half the height and can be seen early without ever looking sliced. Closing
     folds back into that line. */
  .ss-collapse[data-reveal='clip'] > .ss-collapse__inner {
    display: flex;
    flex-direction: column;
    justify-content: center;
    /* Thin rows side by side: a margin would let their windows overlap */
    overflow-clip-margin: 0;
  }

  /* Taller than a row (a comment, a card): it reveals from the top, and its
     content comes in as the space finishes opening, so no line is seen cut.
     Cards and messages read better with reveal="drop". */
  .ss-collapse[data-reveal='clip'][data-tall] > .ss-collapse__inner {
    justify-content: flex-start;
  }

  .ss-collapse[data-reveal='clip'][data-tall][data-open] {
    transition: grid-template-rows 0.46s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.24s ease-out 0.3s;
  }

  /* Settled open, nothing clips: a toolbar or popover can hang off a row */
  .ss-collapse[data-open]:not([data-moving]) > .ss-collapse__inner {
    overflow: visible;
  }

  /* drop: nothing clips; the content arrives whole into the opening space */
  .ss-collapse[data-reveal='drop'] > .ss-collapse__inner {
    overflow: visible;
  }

  /* The glide is a transform on a layer the content keeps for good. Moved by
     layout (top), text steps whole pixels while its box glides, so a count in
     a pill hops inside it; and text that ends a transform without a layer of
     its own is redrawn snapped and hops as it lands. On a lasting layer it
     moves as one picture and rests drawn exactly as it moved. */
  .ss-collapse[data-reveal='drop'] > .ss-collapse__inner > * {
    transform: translateY(-10px);
    will-change: transform;
    transition: transform 0.3s ease;
  }

  .ss-collapse[data-reveal='drop'][data-from='below'] > .ss-collapse__inner > * {
    transform: translateY(10px);
  }

  .ss-collapse[data-reveal='drop'][data-open] > .ss-collapse__inner > * {
    transform: none;
    transition: transform 0.6s cubic-bezier(0.22, 1, 0.36, 1) 0.2s;
  }

  /* Drop content is whole and unclipped, so it waits for most of its space:
     shown early, it would hang over whatever sits below the opening gap */
  .ss-collapse[data-reveal='drop'][data-open] {
    transition: grid-template-rows 0.5s cubic-bezier(0.45, 0, 0.2, 1), opacity 0.3s ease 0.24s;
  }
}
`;document.head.appendChild(Ip);function ha({open:e,reveal:a="clip",from:t="above",solid:n=!1,children:r,className:o,...s}){let[l,u]=ge(!1),[c,m]=ge(!1),g=J(null),h=J(!0);return sa(()=>{let x=g.current?.scrollHeight??0;if(x)m(x>44);if(h.current)return void(h.current=!1);u(!0);let v=setTimeout(()=>u(!1),900);return()=>clearTimeout(v)},[e]),i("div",{...s,className:`ss-collapse${o?` ${o}`:""}`,"data-open":e||void 0,"data-reveal":a,"data-solid":n||void 0,"data-from":a==="drop"?t:void 0,"data-moving":l||void 0,"data-tall":c||void 0,onTransitionEnd:(x)=>{if(x.target===x.currentTarget&&x.propertyName==="grid-template-rows")u(!1);s.onTransitionEnd?.(x)},children:i("div",{ref:g,className:"ss-collapse__inner","data-crop":a==="clip"||void 0,children:r})})}var Cp=document.createElement("style");Cp.textContent=`/* Icon */

@layer stageshow {
  .ss-icon {
    display: block;
    flex-shrink: 0;
  }
}
`;document.head.appendChild(Cp);va();var kp=(e)=>e.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase(),Ts=(...e)=>e.filter((a,t,n)=>Boolean(a)&&a.trim()!==""&&n.indexOf(a)===t).join(" ").trim();va();var Sp={xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};var Pp=Tn(({color:e="currentColor",size:a=24,strokeWidth:t=2,absoluteStrokeWidth:n,className:r="",children:o,iconNode:s,...l},u)=>Vt("svg",{ref:u,...Sp,width:a,height:a,stroke:e,strokeWidth:n?Number(t)*24/Number(a):t,className:Ts("lucide",r),...l},[...s.map(([c,m])=>Vt(c,m)),...Array.isArray(o)?o:[o]]));var R=(e,a)=>{let t=Tn(({className:n,...r},o)=>Vt(Pp,{ref:o,iconNode:a,className:Ts(`lucide-${kp(e)}`,n),...r}));return t.displayName=`${e}`,t};var mt=R("Ellipsis",[["circle",{cx:"12",cy:"12",r:"1",key:"41hilf"}],["circle",{cx:"19",cy:"12",r:"1",key:"1wjl8i"}],["circle",{cx:"5",cy:"12",r:"1",key:"1pcz8c"}]]);var ht=R("House",[["path",{d:"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8",key:"5wwlr5"}],["path",{d:"M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",key:"1d0kgt"}]]);var br=R("Archive",[["rect",{width:"20",height:"5",x:"2",y:"3",rx:"1",key:"1wp1u1"}],["path",{d:"M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8",key:"1s80jp"}],["path",{d:"M10 12h4",key:"a56b0p"}]]);var Mr=R("ArrowRight",[["path",{d:"M5 12h14",key:"1ays0h"}],["path",{d:"m12 5 7 7-7 7",key:"xquz4c"}]]);var Ar=R("ArrowUpRight",[["path",{d:"M7 7h10v10",key:"1tivn9"}],["path",{d:"M7 17 17 7",key:"1vkiza"}]]);var Tr=R("Bell",[["path",{d:"M10.268 21a2 2 0 0 0 3.464 0",key:"vwvbt9"}],["path",{d:"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",key:"11g9vi"}]]);var _r=R("Calendar",[["path",{d:"M8 2v4",key:"1cmpym"}],["path",{d:"M16 2v4",key:"4m81vk"}],["rect",{width:"18",height:"18",x:"3",y:"4",rx:"2",key:"1hopcy"}],["path",{d:"M3 10h18",key:"8toen8"}]]);var zr=R("Check",[["path",{d:"M20 6 9 17l-5-5",key:"1gmf2c"}]]);var Rr=R("ChevronDown",[["path",{d:"m6 9 6 6 6-6",key:"qrunsl"}]]);var Fr=R("ChevronRight",[["path",{d:"m9 18 6-6-6-6",key:"mthhwq"}]]);var Dr=R("Clock",[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["polyline",{points:"12 6 12 12 16 14",key:"68esgv"}]]);var Br=R("CreditCard",[["rect",{width:"20",height:"14",x:"2",y:"5",rx:"2",key:"ynyp8z"}],["line",{x1:"2",x2:"22",y1:"10",y2:"10",key:"1b3vmo"}]]);var Er=R("File",[["path",{d:"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",key:"1rqfz7"}],["path",{d:"M14 2v4a2 2 0 0 0 2 2h4",key:"tnqrlb"}]]);var Nr=R("Globe",[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["path",{d:"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",key:"13o1zl"}],["path",{d:"M2 12h20",key:"9i4pu4"}]]);var Or=R("GripVertical",[["circle",{cx:"9",cy:"12",r:"1",key:"1vctgf"}],["circle",{cx:"9",cy:"5",r:"1",key:"hp0tcf"}],["circle",{cx:"9",cy:"19",r:"1",key:"fkjjf6"}],["circle",{cx:"15",cy:"12",r:"1",key:"1tmaij"}],["circle",{cx:"15",cy:"5",r:"1",key:"19l28e"}],["circle",{cx:"15",cy:"19",r:"1",key:"f4zoj3"}]]);var Ur=R("Heart",[["path",{d:"M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",key:"c3ymky"}]]);var Hr=R("Lock",[["rect",{width:"18",height:"11",x:"3",y:"11",rx:"2",ry:"2",key:"1w4ew1"}],["path",{d:"M7 11V7a5 5 0 0 1 10 0v4",key:"fwvmzm"}]]);var qr=R("Mail",[["rect",{width:"20",height:"16",x:"2",y:"4",rx:"2",key:"18n3k1"}],["path",{d:"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7",key:"1ocrg3"}]]);var Wr=R("Pause",[["rect",{x:"14",y:"4",width:"4",height:"16",rx:"1",key:"zuxfzm"}],["rect",{x:"6",y:"4",width:"4",height:"16",rx:"1",key:"1okwgv"}]]);var Vr=R("Play",[["polygon",{points:"6 3 20 12 6 21 6 3",key:"1oa8hb"}]]);var Gr=R("Plus",[["path",{d:"M5 12h14",key:"1ays0h"}],["path",{d:"M12 5v14",key:"s699le"}]]);var jr=R("ScanFace",[["path",{d:"M3 7V5a2 2 0 0 1 2-2h2",key:"aa7l1z"}],["path",{d:"M17 3h2a2 2 0 0 1 2 2v2",key:"4qcy5o"}],["path",{d:"M21 17v2a2 2 0 0 1-2 2h-2",key:"6vwrx8"}],["path",{d:"M7 21H5a2 2 0 0 1-2-2v-2",key:"ioqczr"}],["path",{d:"M8 14s1.5 2 4 2 4-2 4-2",key:"1y1vjs"}],["path",{d:"M9 9h.01",key:"1q5me6"}],["path",{d:"M15 9h.01",key:"x1ddxp"}]]);var Kr=R("Search",[["circle",{cx:"11",cy:"11",r:"8",key:"4ej97u"}],["path",{d:"m21 21-4.3-4.3",key:"1qie3q"}]]);var Xr=R("Send",[["path",{d:"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",key:"1ffxy3"}],["path",{d:"m21.854 2.147-10.94 10.939",key:"12cjpa"}]]);var $r=R("Settings",[["path",{d:"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",key:"1qme2f"}],["circle",{cx:"12",cy:"12",r:"3",key:"1v7zrd"}]]);var Qr=R("Star",[["path",{d:"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",key:"r04s7s"}]]);var Zr=R("Trash2",[["path",{d:"M3 6h18",key:"d0wm0j"}],["path",{d:"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6",key:"4alrt4"}],["path",{d:"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2",key:"v07s0e"}],["line",{x1:"10",x2:"10",y1:"11",y2:"17",key:"1uufr5"}],["line",{x1:"14",x2:"14",y1:"11",y2:"17",key:"xtxkd"}]]);var Yr=R("User",[["path",{d:"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2",key:"975kel"}],["circle",{cx:"12",cy:"7",r:"4",key:"17ys0d"}]]);var Jr=R("Wifi",[["path",{d:"M12 20h.01",key:"zekei9"}],["path",{d:"M2 8.82a15 15 0 0 1 20 0",key:"dnpr2z"}],["path",{d:"M5 12.859a10 10 0 0 1 14 0",key:"1x1e6c"}],["path",{d:"M8.5 16.429a5 5 0 0 1 7 0",key:"1bycff"}]]);var eo=R("X",[["path",{d:"M18 6 6 18",key:"1bl5f8"}],["path",{d:"m6 6 12 12",key:"d8bk6v"}]]);var ao=R("Zap",[["path",{d:"M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z",key:"1xq2db"}]]);var bp={check:zr,plus:Gr,close:eo,"chevron-right":Fr,"chevron-down":Rr,search:Kr,globe:Nr,external:Ar,clock:Dr,archive:br,trash:Zr,more:mt,arrow:Mr,file:Er,user:Yr,bell:Tr,card:Br,bolt:ao,lock:Hr,play:Vr,pause:Wr,faceid:jr,wifi:Jr,heart:Ur,star:Qr,calendar:_r,mail:qr,send:Xr,home:ht,gear:$r,grip:Or},Qh={chip:"M3.5 2.5h9a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4a1.5 1.5 0 0 1 1.5-1.5zM2 6h4M2 10h4M10 6h4M10 10h4M6 2.5v11M10 2.5v11M6 8h4",contactless:"M6.8 6.2a2.5 2.5 0 0 1 0 3.6M8.5 4.5a5 5 0 0 1 0 7M10.3 2.7a7.5 7.5 0 0 1 0 10.6"},Zh={bolt:"M9.6 1.2 3.2 8.9a.6.6 0 0 0 .5 1H7.4l-1 4.9a.4.4 0 0 0 .7.3l6.4-7.7a.6.6 0 0 0-.5-1H9.3l1-4.9a.4.4 0 0 0-.7-.3Z",card:"M3 3h10a1.75 1.75 0 0 1 1.75 1.75V5.6H1.25v-.85A1.75 1.75 0 0 1 3 3Zm-1.75 4.4h13.5v3.85A1.75 1.75 0 0 1 13 13H3a1.75 1.75 0 0 1-1.75-1.75Zm2.25 2.6v1h3v-1Z",bell:"M8 1.25a4.25 4.25 0 0 0-4.25 4.25v3.1l-1.3 2.1a.6.6 0 0 0 .5.9h10.1a.6.6 0 0 0 .5-.9l-1.3-2.1V5.5A4.25 4.25 0 0 0 8 1.25ZM6.2 13.1a1.9 1.9 0 0 0 3.6 0Z",user:"M8 1.5a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2Zm0 7.4c3.1 0 5.4 1.8 5.9 4.6a.7.7 0 0 1-.7.8H2.8a.7.7 0 0 1-.7-.8C2.6 10.7 4.9 8.9 8 8.9Z",clock:"M8 1.25a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5Zm-.75 3v4.2l2.9 1.75.75-1.25-2.15-1.3V4.25Z",check:"M8 1.25a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5Zm3 4.3-.95-.8-3.3 3.95-1.85-1.8-.85.9 2.8 2.75Z",lock:"M8 1.25A3.25 3.25 0 0 0 4.75 4.5v2H4.5A1.5 1.5 0 0 0 3 8v5.25a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V8a1.5 1.5 0 0 0-1.5-1.5h-.25v-2A3.25 3.25 0 0 0 8 1.25Zm-1.75 5.25v-2a1.75 1.75 0 0 1 3.5 0v2Z",play:"M4.5 2.6v10.8a.8.8 0 0 0 1.2.7l8.6-5.4a.8.8 0 0 0 0-1.4L5.7 1.9a.8.8 0 0 0-1.2.7Z",pause:"M4 2.5h2.6a.6.6 0 0 1 .6.6v9.8a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V3.1a.6.6 0 0 1 .6-.6Zm5.4 0H12a.6.6 0 0 1 .6.6v9.8a.6.6 0 0 1-.6.6H9.4a.6.6 0 0 1-.6-.6V3.1a.6.6 0 0 1 .6-.6Z",heart:"M8 14.2c-.2 0-6.6-3.7-6.6-8.4a3.6 3.6 0 0 1 6.6-2 3.6 3.6 0 0 1 6.6 2c0 4.7-6.4 8.4-6.6 8.4Z",star:"M8 1.2a.6.6 0 0 1 .55.35l1.75 3.6 3.95.55a.6.6 0 0 1 .33 1.03l-2.86 2.8.68 3.94a.6.6 0 0 1-.87.63L8 12.25 4.47 14.1a.6.6 0 0 1-.87-.63l.68-3.94-2.86-2.8a.6.6 0 0 1 .33-1.03l3.95-.55 1.75-3.6A.6.6 0 0 1 8 1.2Z",home:"M7.5 1.6a.8.8 0 0 1 1 0l5.7 4.6a.8.8 0 0 1 .3.6v6.7a1 1 0 0 1-1 1H10V10.3H6v4.2H2.5a1 1 0 0 1-1-1V6.8a.8.8 0 0 1 .3-.6Z",gear:"M6.67 2.46L7.03 0.81L8.97 0.81L9.33 2.46L10.98 3.14L12.40 2.24L13.76 3.60L12.86 5.02L13.54 6.67L15.19 7.03L15.19 8.97L13.54 9.33L12.86 10.98L13.76 12.40L12.40 13.76L10.98 12.86L9.33 13.54L8.97 15.19L7.03 15.19L6.67 13.54L5.02 12.86L3.60 13.76L2.24 12.40L3.14 10.98L2.46 9.33L0.81 8.97L0.81 7.03L2.46 6.67L3.14 5.02L2.24 3.60L3.60 2.24L5.02 3.14ZM5.60 8.00a2.40 2.40 0 1 0 4.80 0a2.40 2.40 0 1 0 -4.80 0Z",calendar:"M3.5 2h9A2 2 0 0 1 14.5 4v8.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm-.5 4.5v6a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-6ZM4.2 7.6h1.6v1.6h-1.6ZM7.2 7.6h1.6v1.6h-1.6ZM10.2 7.6h1.6v1.6h-1.6ZM4.2 10.2h1.6v1.6h-1.6ZM7.2 10.2h1.6v1.6h-1.6ZM10.2 10.2h1.6v1.6h-1.6Z",send:"M14.3 1.7a.55.55 0 0 0-.6-.12L1.75 6.4a.55.55 0 0 0 0 1.02l4.6 1.85 4.9-4.13a.2.2 0 0 1 .28.28L7.4 10.3l1.84 4.6a.55.55 0 0 0 1.02 0l4.83-11.95a.55.55 0 0 0-.12-.6Z",mail:"M2.5 3h11A1.5 1.5 0 0 1 15 4.4L8 8.9 1 4.4A1.5 1.5 0 0 1 2.5 3ZM1 6.1v5.4A1.5 1.5 0 0 0 2.5 13h11a1.5 1.5 0 0 0 1.5-1.5V6.1l-6.6 4.2a.8.8 0 0 1-.8 0Z"};function Ee({name:e,size:a=16,stroke:t=1.5,filled:n,className:r,style:o}){let s=n?Zh[e]:void 0,l=`ss-icon${r?` ${r}`:""}`;if(!s&&e in bp){let u=bp[e];return i(u,{size:a,strokeWidth:t,absoluteStrokeWidth:!0,className:l,style:o,"aria-hidden":!0})}return i("svg",{viewBox:"0 0 16 16",width:a,height:a,className:l,style:o,"aria-hidden":!0,children:s?i("path",{d:s,fill:"currentColor",fillRule:"evenodd"}):i("path",{d:Qh[e],fill:"none",stroke:"currentColor",strokeWidth:t,strokeLinecap:"round",strokeLinejoin:"round"})})}va();var Mp=document.createElement("style");Mp.textContent=`/* Check */

@layer stageshow {
  .ss-check {
    display: inline-grid;
    flex-shrink: 0;
    place-items: center;
  }

  .ss-check svg {
    overflow: visible;
  }

  .ss-check__ring {
    fill: none;
    stroke: var(--ss-ink-4);
    stroke-width: 1.5;
    transition: opacity 0.2s ease;
  }

  /* Pending: an arc turning inside the ring */
  .ss-check__arc {
    fill: none;
    stroke: var(--ss-text-strong);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-dasharray: 0.28 1;
    opacity: 0;
    transform-origin: 8px 8px;
    animation: ss-spin 0.8s linear infinite;
    transition: opacity 0.18s ease;
  }

  .ss-check[data-pending] .ss-check__arc {
    opacity: 1;
  }

  /* Done: a solid disc grows from the center over the ring, then the tick
     draws on it. No frame is a half-faded fill under a fading spinner. */
  .ss-check__fill {
    fill: var(--ss-success);
    opacity: 0;
    transform: scale(0.35);
    transform-origin: 8px 8px;
    transition: opacity 0.2s ease, transform 0.2s ease;
  }

  .ss-check[data-on] .ss-check__fill {
    opacity: 1;
    transform: scale(1);
    transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), opacity 0s;
  }

  /* The arc gets out of the way as the disc starts */
  .ss-check[data-on] .ss-check__arc {
    transition-duration: 0.08s;
  }

  .ss-check[data-on] .ss-check__ring {
    opacity: 0;
  }

  .ss-check__tick {
    fill: none;
    stroke: #fff;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  /* On blueprint the disc is white, so the tick takes the ground */
  .ss-stage[data-theme="blueprint"] .ss-check__tick {
    stroke: var(--ss-well);
  }

  /* The tick draws in once the disc is mostly there, and fades out intact */
  .ss-check[data-on] .ss-check__tick {
    stroke-dashoffset: 0;
    opacity: 1;
    transition: stroke-dashoffset 0.32s cubic-bezier(0.65, 0, 0.35, 1) 0.16s, opacity 0.01s 0.16s;
  }

  .ss-stage[data-palette="mono"][data-theme="dark"] .ss-check__tick {
    stroke: #111;
  }

  @media (prefers-reduced-motion: reduce) {
    .ss-check__arc { animation: none; }
  }
}
`;document.head.appendChild(Mp);function _s({on:e,pending:a,size:t=16,className:n,...r}){return i("span",{...r,className:`ss-check${n?` ${n}`:""}`,"data-on":e||void 0,"data-pending":a&&!e||void 0,style:{width:t,height:t,...r.style},children:L("svg",{viewBox:"0 0 16 16",width:t,height:t,"aria-hidden":!0,children:[i("circle",{className:"ss-check__ring",cx:"8",cy:"8",r:"7.25"}),i("circle",{className:"ss-check__arc",cx:"8",cy:"8",r:"7.25",pathLength:1}),i("circle",{className:"ss-check__fill",cx:"8",cy:"8",r:"8"}),i("path",{className:"ss-check__tick",d:"M4.5 8.2 7 10.6l4.6-5",pathLength:1})]})})}var Ap=document.createElement("style");Ap.textContent=`/* Spinner */

@layer stageshow {
  .ss-spinner {
    flex: none;
    animation: ss-spin 0.8s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .ss-spinner { animation: none; }
  }
}
`;document.head.appendChild(Ap);function zs({size:e=14,className:a,style:t,...n}){return L("svg",{...n,className:`ss-spinner${a?` ${a}`:""}`,viewBox:"0 0 16 16",width:e,height:e,style:t,"aria-hidden":!0,children:[i("circle",{cx:"8",cy:"8",r:"6.25",fill:"none",stroke:"currentColor",strokeOpacity:"0.18",strokeWidth:"1.5"}),i("path",{d:"M8 1.75a6.25 6.25 0 0 1 6.25 6.25",fill:"none",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round"})]})}var Tp=()=>window.matchMedia("(prefers-color-scheme: dark)");function Rs(){let[e,a]=ge(()=>Tp().matches);return qa(()=>{let t=Tp(),n=()=>a(t.matches);return t.addEventListener("change",n),()=>t.removeEventListener("change",n)},[]),e}function Ke({children:e,className:a}){return i("span",{className:a,children:e.map((t,n)=>L("span",{children:[n>0&&" ",i("span",{className:"ph",children:t})]},n))})}function Cn({size:e=22}){return i("span",{className:"dz-mark",style:{width:e,height:e},"aria-hidden":!0,children:i("span",{})})}function Fs({send:e,at:a,target:t="send"}){return L("div",{className:"dz-acts-cell",children:[L("div",{className:"dz-acts","data-off":e==="done"||void 0,children:[L("span",{className:"dz-btn dz-btn--send","data-target":t,"data-cursor":"pointer",children:[i("span",{className:"dz-layer","data-on":e==="idle"||void 0,children:"보내기"}),i("span",{className:"dz-layer","data-on":e==="busy"||void 0,children:i(zs,{size:14})})]}),i("span",{className:"dz-btn",children:"고치기"}),i("span",{className:"dz-btn dz-btn--text",children:"보내지 않기"})]}),L("div",{className:"dz-sent","data-off":e!=="done"||void 0,children:[i(_s,{on:e==="done",size:16}),"보냈어요",i("span",{className:"dz-sent__time",children:a})]})]})}var _p=document.createElement("style");_p.textContent=`.hz .ss-stage {
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 56px), transparent);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 56px), transparent);
}

.hz-win {
  position: absolute;
  top: 8px;
  left: 24px;
  width: 952px;
  height: 640px;
  box-shadow: var(--ss-shadow-hero);
}

.hz-app {
  display: grid;
  grid-template-rows: 46px 1fr;
  height: 100%;
  background: var(--bg);
  color: var(--ink);
  font-size: 13px;
}

.dz-mark {
  display: inline-grid;
  place-items: center;
  flex: none;
  border-radius: 28%;
  background: var(--ink);
}
.dz-mark > span {
  width: 36%;
  height: 36%;
  border-radius: 30%;
  background: var(--bg);
}

.hz-nav {
  display: flex;
  align-items: stretch;
  gap: 22px;
  padding: 0 20px;
  border-bottom: 1px solid var(--line);
}
.hz-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: 10px;
  font-weight: 600;
  font-size: 14px;
}
.hz-tab {
  display: flex;
  align-items: center;
  color: var(--muted);
  border-bottom: 2px solid transparent;
}
.hz-tab[data-on] {
  color: var(--ink);
  font-weight: 600;
  border-bottom-color: var(--ink);
}

.hz-main {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 20px;
  min-height: 0;
  padding: 16px 20px 0;
}

.hz-side {
  display: grid;
  align-content: start;
  gap: 2px;
  padding: 8px;
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: 0 0 0 1px var(--line);
}
.hz-item {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
}
.hz-item[data-on] { background: var(--surface-2); }
.hz-ic {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--muted);
}
.hz-item[data-on] .hz-ic { background: var(--surface); }
.hz-item__t { display: grid; gap: 5px; min-width: 0; }
.hz-item__t b { font-weight: 600; font-size: 13px; }
.hz-item__t > span:not(.ss-bar) {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hz-sec { padding: 12px 10px 4px; color: var(--muted); font-size: 12px; }

.hz-chat {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-height: 0;
  height: 100%;
}
.hz-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 2px 0 12px;
}
.hz-head > span:last-child { display: grid; gap: 3px; }
.hz-head b { font-size: 14px; font-weight: 600; }
.hz-head b + span { color: var(--muted); font-size: 12px; }

.hz-thread {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 16px;
  min-height: 0;
  max-width: 560px;
  width: 100%;
  margin: 0 auto;
  padding: 0 0 18px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 40px);
  mask-image: linear-gradient(to bottom, transparent, #000 40px);
}
.hz-thread > * { will-change: transform; flex: none; }

.hz-me { display: grid; justify-items: end; gap: 5px; }
.hz-bubble {
  max-width: 80%;
  padding: 9px 14px;
  border-radius: 18px;
  background: var(--surface-2);
  color: var(--ink);
  font-size: 13.5px;
  line-height: 1.45;
}
.hz-time { color: var(--muted); font-size: 11.5px; }

.hz-bot { display: grid; gap: 6px; }
.hz-meta { color: var(--muted); font-size: 12px; }
.hz-meta b { color: var(--ink); font-weight: 600; }
.hz-text { color: var(--ink); font-size: 14px; line-height: 1.55; }

.hz-notice {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12.5px;
}
.hz-notice .ss-icon { color: var(--accent); }
.hz-notice__time { color: var(--muted); opacity: 0.8; }

.hz-draft { max-width: 440px; }

.hz-composer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  max-width: 560px;
  width: 100%;
  margin: 0 auto 32px;
  height: 52px;
  padding: 0 10px 0 18px;
  border-radius: 16px;
  background: var(--surface);
  box-shadow: 0 0 0 1px var(--line);
  color: var(--muted);
}
.hz-composer__go {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--muted);
}

.hz .ss-stage[data-layout='compact'] .hz-win {
  left: 8px;
  width: 342px;
  height: 600px;
}
.hz .ss-stage[data-layout='compact'] .hz-main {
  grid-template-columns: minmax(0, 1fr);
  padding: 12px 14px 0;
}
.hz .ss-stage[data-layout='compact'] .hz-nav { padding: 0 14px; }
.hz .ss-stage[data-layout='compact'] .hz-composer { margin-bottom: 28px; height: 46px; }
.hz .ss-stage[data-layout='compact'] .hz-text { font-size: 13.5px; }
.hz .ss-stage[data-layout='compact'] .dz-draft { padding: 12px 12px; }
.hz .ss-stage[data-layout='compact'] .dz-btn { padding: 0 11px; }
.hz .ss-stage[data-layout='compact'] .dz-btn--text { padding: 0 6px; }
`;document.head.appendChild(_p);var Yh={mail:!1,summary:!1,draft:!1,send:"idle"},Jh={mail:!0,summary:!0,draft:!0,send:"idle"};async function eg(e){await e.wait(700),e.put({mail:!0}),await e.wait(1100),e.put({summary:!0}),await e.wait(1300),e.put({draft:!0}),await e.wait(1500),await e.click({at:"send",x:0.55,y:0.6}),e.put({send:"busy"}),await e.wait(800),e.put({send:"done"}),await e.move({wide:{x:900,y:470},compact:{x:320,y:470}}),await e.wait(2000),e.put({draft:!1}),await e.wait(70),e.put({summary:!1}),await e.wait(70),e.put({mail:!1}),await e.wait(700),e.put({send:"idle"})}var ag=["홈","채팅","프로젝트","모니터링","설정"];function tg(){return L("div",{className:"hz-side",children:[L("div",{className:"hz-item","data-on":!0,children:[i("span",{className:"hz-ic",children:i(Cn,{size:16})}),L("span",{className:"hz-item__t",children:[i("b",{children:"dotz"}),i("span",{children:"새 메일을 정리하고 있어요"})]})]}),L("div",{className:"hz-item",children:[i("span",{className:"hz-ic",children:i(Ee,{name:"bell",size:14})}),L("span",{className:"hz-item__t",children:[i("b",{children:"알림"}),i(na,{w:96,h:6,tone:2})]})]}),L("div",{className:"hz-item",children:[i("span",{className:"hz-ic",children:i(Ee,{name:"clock",size:14})}),L("span",{className:"hz-item__t",children:[i("b",{children:"작업내역"}),i(na,{w:110,h:6,tone:2})]})]}),i("div",{className:"hz-sec",children:"프로젝트"}),[120,92].map((e,a)=>L("div",{className:"hz-item",children:[i("span",{className:"hz-ic",children:i(Ee,{name:"file",size:14})}),L("span",{className:"hz-item__t",children:[i(na,{w:60+a*14,h:7,tone:3}),i(na,{w:e,h:6,tone:2})]})]},a))]})}function hi(){let e=Rs();return i(As,{className:"dz hz",width:1000,height:600,compact:{below:600,width:358,height:560},fill:!0,theme:e?"dark":"light",initial:Yh,poster:Jh,script:eg,play:"loop",cursor:{at:{wide:{x:900,y:470},compact:{x:320,y:470}}},children:(a,t,n)=>i(vp,{title:"dotz",className:"hz-win",children:L("div",{className:"hz-app",children:[L("div",{className:"hz-nav",children:[L("span",{className:"hz-brand",children:[i(Cn,{size:20}),"dotz"]}),(n==="wide"?ag:["채팅"]).map((r)=>i("span",{className:"hz-tab","data-on":r==="채팅"||void 0,children:r},r))]}),L("div",{className:"hz-main",children:[n==="wide"&&i(tg,{}),L("div",{className:"hz-chat",children:[L("div",{className:"hz-head",children:[i(Cn,{size:30}),L("span",{children:[i("b",{children:"dotz"}),i("span",{children:"대기 중"})]})]}),L("div",{className:"hz-thread",children:[i("div",{className:"hz-me",children:i(na,{w:210,h:36,r:18,tone:1})}),L("div",{className:"hz-bot hz-past",children:[i(na,{w:90,h:7,tone:2}),i(na,{w:380,h:8,tone:2}),i(na,{w:260,h:8,tone:2})]}),L("div",{className:"hz-me",children:[i("span",{className:"hz-bubble",children:i(Ke,{children:["새 메일이 오면","요약하고 답장 초안 써 줘"]})}),i("span",{className:"hz-time",children:"오전 9:12"})]}),L("div",{className:"hz-bot",children:[L("span",{className:"hz-meta",children:[i("b",{children:"dotz"})," · 오전 9:12"]}),i(Ke,{className:"hz-text",children:["알겠어요.","보내기 전에 꼭 보여 드릴게요."]})]}),i(ha,{open:a.mail,reveal:"drop",from:"below",children:L("div",{className:"hz-notice",children:[i(Ee,{name:"mail",size:14}),i("span",{children:"새 메일 · 한지우 · 다음 주 촬영 일정"}),i("span",{className:"hz-notice__time",children:"오전 9:41"})]})}),i(ha,{open:a.summary,reveal:"drop",from:"below",children:L("div",{className:"hz-bot",children:[L("span",{className:"hz-meta",children:[i("b",{children:"dotz"})," · 오전 9:41"]}),i(Ke,{className:"hz-text",children:["한지우 님이","다음 주 화요일 오후에","촬영이 되는지 물어봤어요."]})]})}),i(ha,{open:a.draft,reveal:"drop",from:"below",children:L("div",{className:"dz-draft hz-draft",children:[L("div",{className:"dz-draft__hd",children:[i(Ee,{name:"send",size:14}),i("span",{className:"dz-draft__title",children:"보낼 초안: 답장"}),i("span",{children:"메일"})]}),L("div",{className:"dz-draft__to",children:[i("span",{children:"받는 사람"}),i("b",{children:"한지우"})]}),i("div",{className:"dz-draft__body",children:i(Ke,{children:["화요일 오후 2시 좋아요.","성수 스튜디오에서 뵐게요."]})}),i(Fs,{send:a.send,at:"오전 9:42"})]})})]}),L("div",{className:"hz-composer",children:[i("span",{children:"메시지 보내기"}),i("span",{className:"hz-composer__go",children:i(Ee,{name:"arrow",size:14})})]})]})]})]})})})}var zp=document.createElement("style");zp.textContent=`/* Avatar */

@layer stageshow {
  /* Small boxes with text keep a layer of their own. Pushed by a row opening
     above them, or carried along by anything that moves by layout, their text
     would step whole pixels while the fill glides, and hop about inside it */
  .ss-avatar {
    will-change: transform;
  }

  .ss-avatar {
    display: inline-grid;
    flex-shrink: 0;
    place-items: center;
    overflow: hidden;
    border-radius: 50%;
    /* Opaque: avatars overlap in a pile, and a translucent fill onion-skins */
    background: var(--ss-fill, var(--ss-ink-3));
    color: var(--ss-text-strong);
    font-weight: 600;
    line-height: 1;
    transition: background 0.3s ease, color 0.3s ease;
  }

  .ss-avatar[data-tone="accent"] {
    background: var(--ss-accent);
    color: #fff;
  }

  /* The iOS contact monogram: Apple's gray-blue, lighter at the top */
  .ss-avatar[data-tone="ios"] {
    background: linear-gradient(180deg, #a5abb8, #858a96);
    color: #fff;
    font-family: ui-rounded, 'SF Pro Rounded', -apple-system, system-ui, sans-serif;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .ss-avatar[data-tone="success"] {
    background: var(--ss-success);
    color: #fff;
  }

  /* The line box trimmed to cap height and baseline, so a capital centers on
     its own ink in any font (a plain line box drops system-ui caps ~7% low) */
  .ss-avatar__initial {
    display: block;
    text-box: trim-both cap alphabetic;
  }

  .ss-avatar img {
    width: 100%;
    height: 100%;
    border-radius: inherit;
    object-fit: cover;
  }

  /* A ring with a gap cut from whatever the avatar sits on (the gap is the
     surface color, so set --ss-ring-bg on a tinted row) */
  .ss-avatar[data-ring] {
    box-shadow: 0 0 0 1.5px var(--ss-ring-bg, var(--ss-surface)), 0 0 0 3px var(--ss-ring, var(--ss-ink-3));
    transition: box-shadow 0.35s ease;
  }

  .ss-avatar[data-ring="confirmed"] { --ss-ring: var(--ss-success); }

  .ss-avatar[data-ring="declined"] { --ss-ring: var(--ss-danger); }

  /* Waiting: the quiet ring, with an accent arc traveling round it (a
     person being asked, a call ringing). It turns smoothly at a steady
     pace; the arc fades out as the ring settles to confirmed or declined */
  .ss-avatar[data-ring] {
    position: relative;
    overflow: visible;
  }

  .ss-avatar[data-ring]::after {
    content: '';
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    background: conic-gradient(from 0deg, transparent 0 62%, var(--ss-accent) 100%);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.5px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.5px));
    opacity: 0;
    transition: opacity 0.3s ease;
    animation: ss-avatar-wait 1.1s linear infinite;
    pointer-events: none;
  }

  .ss-avatar[data-ring="waiting"]::after {
    opacity: 1;
  }

  @keyframes ss-avatar-wait {
    to { transform: rotate(1turn); }
  }

  @media (prefers-reduced-motion: reduce) {
    .ss-avatar[data-ring]::after { animation: none; }
  }
}
`;document.head.appendChild(zp);var Rp=["#c98f6e","#6f9b7d","#7b86c7","#c47a9e","#8c9ab0","#c2a35a"],ng=(e)=>{let a=0;for(let t of e)a=(a*31+t.charCodeAt(0))%9973;return Rp[a%Rp.length]};function Fp({name:e="",plain:a=!1,size:t=24,tone:n=e?"person":"ink",src:r,ring:o,className:s,style:l,...u}){let{fidelity:c}=pi(),m=a||c==="minimal",g=n==="person"&&!m?{background:ng(e),color:"#fff"}:void 0,h=e.trim().split(/\s+/).filter(Boolean),x=n==="ios"?(h[0]?.[0]??"")+(h.length>1?h[h.length-1][0]:""):e.trim()[0]??"";return i("span",{...u,className:`ss-avatar${s?` ${s}`:""}`,"data-tone":n,"data-ring":o,style:{width:t,height:t,fontSize:Math.round(t*(n==="ios"?0.4:t<24?0.5:0.42)),...g,...l},children:r&&!m?i("img",{src:r,alt:""}):m?null:i("span",{className:"ss-avatar__initial",children:x.toUpperCase()})})}var Dp=document.createElement("style");Dp.textContent=`.cz .ss-stage { overflow: hidden; }

.cz-panel {
  position: absolute;
  top: 24px;
  left: 28px;
  width: 560px;
  height: 320px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px;
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: var(--ss-shadow-ground);
  color: var(--ink);
  font-size: 13px;
}
.cz-panel > * { flex: none; will-change: transform; }

.cz-head { display: flex; align-items: center; gap: 8px; }
.cz-meta { color: var(--muted); font-size: 12px; }
.cz-meta b { color: var(--ink); font-weight: 600; }
.cz-tag {
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 11.5px;
  font-weight: 600;
}
.cz-text { display: block; color: var(--ink); font-size: 14px; line-height: 1.55; }
.cz-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}
.cz-title .ss-icon { color: var(--muted); }

.cz-list {
  display: grid;
  max-width: 400px;
  border-radius: var(--radius-sm);
  box-shadow: 0 0 0 1px var(--line);
}
.cz-list > :not(:first-child) .cz-ev { border-top: 1px solid var(--line); }
.cz-ev {
  display: grid;
  grid-template-columns: 52px 1fr;
  align-items: center;
  height: 36px;
  padding: 0 12px;
}
.cz-ev__t { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12.5px; }
.cz-ev__title { font-size: 13.5px; }

.cz-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--body);
  font-size: 12.5px;
}
.cz-chip .ss-icon { color: var(--accent); }

.cz-comment { display: grid; grid-template-columns: 28px 1fr; gap: 10px; align-items: start; }
.cz-comment__b { display: grid; gap: 4px; }
.cz-draft { max-width: 400px; padding: 12px 14px; }

.cz-alerts { display: grid; max-width: 440px; }
.cz-alerts > :not(:first-child) .cz-alert,
.cz-alerts > .cz-alert:not(:first-child) { border-top: 1px solid var(--line); }
.cz-alert {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 11px 4px;
}
.cz-alert__ic {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--muted);
}
.cz-alert[data-new] .cz-alert__ic { background: var(--accent-soft); color: var(--accent); }
.cz-alert__b { display: grid; gap: 5px; min-width: 0; }
.cz-alert__b b { font-weight: 600; font-size: 13.5px; }
.cz-alert__b > span { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.cz-alert__time { color: var(--muted); font-size: 11.5px; align-self: start; padding-top: 2px; }
.cz-price s { color: var(--muted); }
.cz-price em { font-style: normal; font-weight: 600; color: var(--accent-ink); }

.cz-task {
  display: grid;
  gap: 12px;
  max-width: 440px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  box-shadow: 0 0 0 1px var(--line);
}
.cz-task__row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cz-task__name { display: grid; gap: 4px; }
.cz-task__t { font-size: 13.5px; font-weight: 600; }
.cz-badge {
  display: inline-grid;
  grid-template-areas: 'stack';
  place-items: center;
  height: 24px;
  min-width: 64px;
  padding: 0 9px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 600;
  transition: background-color 0.3s ease, color 0.3s ease;
}
.cz-badge > * { grid-area: stack; gap: 5px; }
.cz-badge[data-done] { background: var(--accent-soft); color: var(--accent-ink); }
.cz-badge .ss-check__fill { fill: var(--accent); }
.cz-badge .ss-check__tick { stroke: var(--accent-soft); }
.cz-meter { height: 4px; border-radius: 2px; background: var(--surface-2); overflow: hidden; }
.cz-meter > span {
  display: block;
  height: 100%;
  width: 100%;
  border-radius: inherit;
  background: var(--accent);
  transform: scaleX(0.35);
  transform-origin: 0 50%;
  transition: transform 2.2s cubic-bezier(0.45, 0, 0.2, 1);
}
.cz-meter > span[data-run] { transform: scaleX(1); }

.cz-bot { display: grid; gap: 8px; }
.cz-file {
  display: flex;
  align-items: center;
  gap: 10px;
  width: fit-content;
  padding: 8px 14px 8px 8px;
  border-radius: var(--radius-sm);
  box-shadow: 0 0 0 1px var(--line);
}
.cz-file > span:last-child { display: grid; gap: 3px; }
.cz-file b { font-weight: 600; font-size: 13px; }
.cz-file b + span { color: var(--muted); font-size: 11.5px; }
.cz-file__ic {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent);
}

.cz .ss-stage[data-layout='compact'] .cz-panel {
  top: 18px;
  left: 16px;
  /* still bleeds off the right edge, but its content ends inside the 350px stage */
  width: 360px;
  padding: 16px 40px 16px 16px;
}
`;document.head.appendChild(Dp);function Ds({name:e,initial:a,poster:t,script:n,cursor:r,children:o}){let s=Rs();return i(As,{className:`dz cz cz--${e}`,width:520,height:280,compact:{below:440,width:350,height:270},theme:s?"dark":"light",initial:a,poster:t,script:n,play:"once",fill:!0,cursor:r?{at:{wide:{x:470,y:250},compact:{x:320,y:250}},idle:!1}:void 0,children:(l)=>i("div",{className:"cz-panel",children:o(l)})})}var Bp=({at:e,tag:a})=>L("div",{className:"cz-head",children:[i(Cn,{size:22}),L("span",{className:"cz-meta",children:[i("b",{children:"dotz"})," · ",e]}),a&&i("span",{className:"cz-tag",children:a})]}),rg=[["10:00",["팀 주간 회의"]],["13:30",["치과 예약"]],["19:00",["저녁 약속","· 연남동"]]];function Ep(){return i(Ds,{name:"brief",initial:{msg:!1,rows:0,mail:!1},poster:{msg:!0,rows:3,mail:!0},script:async(e)=>{await e.wait(500),e.put({msg:!0}),await e.wait(700);for(let a=1;a<=3;a++)e.put({rows:a}),await e.wait(260);await e.wait(400),e.put({mail:!0})},children:(e)=>L(Ma,{children:[i(Bp,{at:"오전 9:00",tag:"아침 점검"}),i(ha,{open:e.msg,reveal:"drop",from:"below",children:i(Ke,{className:"cz-text",children:["좋은 아침이에요.","오늘 일정은 세 개예요."]})}),i("div",{className:"cz-list",children:rg.map(([a,t],n)=>i(ha,{open:e.rows>n,children:L("div",{className:"cz-ev",children:[i("span",{className:"cz-ev__t",children:a}),i(Ke,{className:"cz-ev__title",children:t})]})},a))}),i(ha,{open:e.mail,reveal:"drop",from:"below",children:L("div",{className:"cz-chip",children:[i(Ee,{name:"mail",size:13}),i(Ke,{children:["새 메일 2통은","요약해 뒀어요"]})]})})]})})}function Np(){return i(Ds,{name:"reply",cursor:!0,initial:{draft:!1,send:"idle"},poster:{draft:!0,send:"done"},script:async(e)=>{await e.wait(500),e.put({draft:!0}),await e.wait(1300),await e.click({at:"send",x:0.55,y:0.6}),e.put({send:"busy"}),await e.wait(700),e.put({send:"done"}),await e.move({wide:{x:470,y:250},compact:{x:320,y:250}})},children:(e)=>L(Ma,{children:[L("div",{className:"cz-comment",children:[i(Fp,{name:"산",size:28}),L("div",{className:"cz-comment__b",children:[L("span",{className:"cz-meta",children:[i("b",{children:"산책하는고양이"})," · 유튜브 댓글"]}),i(Ke,{className:"cz-text",children:["영상 잘 봤어요!","다음 편은 언제 올라와요?"]})]})]}),i(ha,{open:e.draft,reveal:"drop",from:"below",children:L("div",{className:"dz-draft cz-draft",children:[i("div",{className:"dz-draft__body",children:i(Ke,{children:["다음 주 금요일에 올라가요.","봐 주셔서 고마워요!"]})}),i(Fs,{send:e.send,at:"방금"})]})})]})})}function Op(){return i(Ds,{name:"watch",initial:{alert:!1},poster:{alert:!0},script:async(e)=>{await e.wait(600),e.put({alert:!0})},children:(e)=>L(Ma,{children:[L("div",{className:"cz-title",children:[i(Ee,{name:"bell",size:15}),"알림"]}),L("div",{className:"cz-alerts",children:[i(ha,{open:e.alert,reveal:"drop",children:L("div",{className:"cz-alert","data-new":!0,children:[i("span",{className:"cz-alert__ic",children:i(Ee,{name:"bell",size:14})}),L("span",{className:"cz-alert__b",children:[i("b",{children:"가격이 바뀌었어요"}),L("span",{className:"cz-price",children:["캠핑 의자 ",i("s",{children:"89,000원"})," → ",i("em",{children:"72,000원"})]})]}),i("span",{className:"cz-alert__time",children:"방금"})]})}),L("div",{className:"cz-alert",children:[i("span",{className:"cz-alert__ic",children:i(Ee,{name:"lock",size:14})}),L("span",{className:"cz-alert__b",children:[i("b",{children:"로그인 유지"}),i("span",{children:"사이트 세 곳 · 바뀐 것 없음"})]}),i("span",{className:"cz-alert__time",children:"오전 8:00"})]}),L("div",{className:"cz-alert",children:[i("span",{className:"cz-alert__ic",children:i(Ee,{name:"globe",size:14})}),L("span",{className:"cz-alert__b",children:[i(na,{w:120,h:7,tone:3}),i(na,{w:170,h:6,tone:2})]}),i("span",{className:"cz-alert__time",children:"어제"})]})]})]})})}function Up(){return i(Ds,{name:"task",initial:{run:!1,done:!1,file:!1},poster:{run:!0,done:!0,file:!0},script:async(e)=>{await e.wait(300),e.put({run:!0}),await e.wait(2300),e.put({done:!0}),await e.wait(500),e.put({file:!0})},children:(e)=>L(Ma,{children:[L("div",{className:"cz-title",children:[i(Ee,{name:"file",size:15}),"블로그 글"]}),L("div",{className:"cz-task",children:[L("div",{className:"cz-task__row",children:[L("span",{className:"cz-task__name",children:[i("span",{className:"cz-meta",children:"백그라운드 작업"}),i(Ke,{className:"cz-task__t",children:["캠핑장 세 곳","비교해서 정리하기"]})]}),L("span",{className:"cz-badge","data-done":e.done||void 0,children:[L("span",{className:"dz-layer","data-on":!e.done||void 0,children:[i(zs,{size:11}),"진행 중"]}),L("span",{className:"dz-layer","data-on":e.done||void 0,children:[i(_s,{on:e.done,size:12}),"완료"]})]})]}),i("div",{className:"cz-meter",children:i("span",{"data-run":e.run||void 0})})]}),i(ha,{open:e.file,reveal:"drop",from:"below",children:L("div",{className:"cz-bot",children:[i(Bp,{at:"오후 3:12"}),i(Ke,{className:"cz-text",children:["정리했어요.","결과 파일을 올려 뒀어요."]}),L("div",{className:"cz-file",children:[i("span",{className:"cz-file__ic",children:i(Ee,{name:"file",size:15})}),L("span",{children:[i("b",{children:"캠핑장_비교.md"}),i("span",{children:"결과 파일 · 3.1KB"})]})]})]})})]})})}var og={hero:hi,briefing:Ep,comment:Np,watch:Op,task:Up},sg=(e)=>{let a=og[e.dataset.ss??""];if(!a)return;Hp.createRoot(e).render(i(a,{})),e.closest(".shot, .card")?.classList.add("ss-live")},qp=new IntersectionObserver((e)=>{for(let a of e){if(!a.isIntersecting)continue;qp.unobserve(a.target),sg(a.target)}},{rootMargin:"300px 0px"});for(let e of document.querySelectorAll("[data-ss]"))qp.observe(e);
