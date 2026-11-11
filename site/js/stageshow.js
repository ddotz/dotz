var $p=Object.create;var{getPrototypeOf:Zp,defineProperty:yi,getOwnPropertyNames:Qp}=Object;var vi=Object.prototype.hasOwnProperty;function Yp(e){return this[e]}var Jp,em,wi=(e,t,a)=>{var n=e!=null&&typeof e==="object";if(n){var r=t?Jp??=new WeakMap:em??=new WeakMap,o=r.get(e);if(o)return o}a=e!=null?$p(Zp(e)):{};let s=t||!e||!e.__esModule||!vi.call(e,"default")?yi(a,"default",{value:e,enumerable:!0}):a;if(e&&typeof e==="object"||typeof e==="function"){for(let l of Qp(e))if(!vi.call(s,l))yi(s,l,{get:Yp.bind(e,l),enumerable:!0})}if(n)r.set(e,s);return s};var Ii=(e,t)=>()=>(t||e((t={exports:{}}).exports,t),t.exports);var Hs=(e,t,a)=>()=>{if(e)try{t=e(e=0)}catch(n){a=[n]}if(a)throw a[0];return t};function Mn(e,t,a){this.props=e,this.context=t,this.refs=Ci,this.updater=a||ki}function Si(){}function Pi(e,t,a){this.props=e,this.context=t,this.refs=Ci,this.updater=a||ki}function um(e,t,a){var n,r={},o=null,s=null;if(t!=null)for(n in t.ref!==void 0&&(s=t.ref),t.key!==void 0&&(o=""+t.key),t)sm.call(t,n)&&!lm.hasOwnProperty(n)&&(r[n]=t[n]);var l=arguments.length-2;if(l===1)r.children=a;else if(1<l){for(var u=Array(l),c=0;c<l;c++)u[c]=arguments[c+2];r.children=u}if(e&&e.defaultProps)for(n in l=e.defaultProps,l)r[n]===void 0&&(r[n]=l[n]);return{$$typeof:tm,type:e,key:o,ref:s,props:r,_owner:bi.current}}var tm,am,nm,rm,ki,om,Ci,Ws,sm,bi,lm,Rt,im,dm,An,Tn=function(e){return e={$$typeof:nm,_currentValue:e,_currentValue2:e,_threadCount:0,Provider:null,Consumer:null,_defaultValue:null,_globalName:null},e.Provider={$$typeof:am,_context:e},e.Consumer=e},ja,Rn=function(e){return{$$typeof:rm,render:e}},Ft=function(e,t){return Rt.current.useCallback(e,t)},Fn=function(e){return Rt.current.useContext(e)},kt=function(e,t){return Rt.current.useEffect(e,t)},Vs=function(){return Rt.current.useId()},lt=function(e,t){return Rt.current.useLayoutEffect(e,t)},so=function(e,t){return Rt.current.useMemo(e,t)},Z=function(e){return Rt.current.useRef(e)},pe=function(e){return Rt.current.useState(e)};var ut=Hs(()=>{tm=Symbol.for("react.element"),am=Symbol.for("react.provider"),nm=Symbol.for("react.context"),rm=Symbol.for("react.forward_ref"),ki={isMounted:function(){return!1},enqueueForceUpdate:function(){},enqueueReplaceState:function(){},enqueueSetState:function(){}},om=Object.assign,Ci={};Mn.prototype.isReactComponent={};Mn.prototype.setState=function(e,t){if(typeof e!=="object"&&typeof e!=="function"&&e!=null)throw Error("setState(...): takes an object of state variables to update or a function which returns an object of state variables.");this.updater.enqueueSetState(this,e,t,"setState")};Mn.prototype.forceUpdate=function(e){this.updater.enqueueForceUpdate(this,e,"forceUpdate")};Si.prototype=Mn.prototype;Ws=Pi.prototype=new Si;Ws.constructor=Pi;om(Ws,Mn.prototype);Ws.isPureReactComponent=!0;sm=Object.prototype.hasOwnProperty,bi={current:null},lm={key:!0,ref:!0,__self:!0,__source:!0};Rt={current:null},im={transition:null},dm={ReactCurrentDispatcher:Rt,ReactCurrentBatchConfig:im,ReactCurrentOwner:bi};An=dm,ja=um});var Bi=Ii(function(Xa){function js(e,t){var a=e.length;e.push(t);e:for(;0<a;){var n=a-1>>>1,r=e[n];if(0<lo(r,t))e[n]=t,e[a]=r,a=n;else break e}}function it(e){return e.length===0?null:e[0]}function co(e){if(e.length===0)return null;var t=e[0],a=e.pop();if(a!==t){e[0]=a;e:for(var n=0,r=e.length,o=r>>>1;n<o;){var s=2*(n+1)-1,l=e[s],u=s+1,c=e[u];if(0>lo(l,a))u<r&&0>lo(c,l)?(e[n]=c,e[u]=a,n=u):(e[n]=l,e[s]=a,n=s);else if(u<r&&0>lo(c,a))e[n]=c,e[u]=a,n=u;else break e}}return t}function lo(e,t){var a=e.sortIndex-t.sortIndex;return a!==0?a:e.id-t.id}if(typeof performance==="object"&&typeof performance.now==="function")Ks=performance,Xa.unstable_now=function(){return Ks.now()};else uo=Date,Xs=uo.now(),Xa.unstable_now=function(){return uo.now()-Xs};var Ks,uo,Xs,Ct=[],Ht=[],fm=1,Qe=null,Ae=3,po=!1,va=!1,Dn=!1,Ti=typeof setTimeout==="function"?setTimeout:null,Ri=typeof clearTimeout==="function"?clearTimeout:null,Ai=typeof setImmediate<"u"?setImmediate:null;typeof navigator<"u"&&navigator.scheduling!==void 0&&navigator.scheduling.isInputPending!==void 0&&navigator.scheduling.isInputPending.bind(navigator.scheduling);function $s(e){for(var t=it(Ht);t!==null;){if(t.callback===null)co(Ht);else if(t.startTime<=e)co(Ht),t.sortIndex=t.expirationTime,js(Ct,t);else break;t=it(Ht)}}function Qs(e){if(Dn=!1,$s(e),!va)if(it(Ct)!==null)va=!0,Js(Ys);else{var t=it(Ht);t!==null&&el(Qs,t.startTime-e)}}function Ys(e,t){va=!1,Dn&&(Dn=!1,Ri(Bn),Bn=-1),po=!0;var a=Ae;try{$s(t);for(Qe=it(Ct);Qe!==null&&(!(Qe.expirationTime>t)||e&&!Di());){var n=Qe.callback;if(typeof n==="function"){Qe.callback=null,Ae=Qe.priorityLevel;var r=n(Qe.expirationTime<=t);t=Xa.unstable_now(),typeof r==="function"?Qe.callback=r:Qe===it(Ct)&&co(Ct),$s(t)}else co(Ct);Qe=it(Ct)}if(Qe!==null)var o=!0;else{var s=it(Ht);s!==null&&el(Qs,s.startTime-t),o=!1}return o}finally{Qe=null,Ae=a,po=!1}}var mo=!1,io=null,Bn=-1,Fi=5,zi=-1;function Di(){return Xa.unstable_now()-zi<Fi?!1:!0}function Gs(){if(io!==null){var e=Xa.unstable_now();zi=e;var t=!0;try{t=io(!0,e)}finally{t?zn():(mo=!1,io=null)}}else mo=!1}var zn;if(typeof Ai==="function")zn=function(){Ai(Gs)};else if(typeof MessageChannel<"u")fo=new MessageChannel,Zs=fo.port2,fo.port1.onmessage=Gs,zn=function(){Zs.postMessage(null)};else zn=function(){Ti(Gs,0)};var fo,Zs;function Js(e){io=e,mo||(mo=!0,zn())}function el(e,t){Bn=Ti(function(){e(Xa.unstable_now())},t)}Xa.unstable_IdlePriority=5;Xa.unstable_ImmediatePriority=1;Xa.unstable_LowPriority=4;Xa.unstable_NormalPriority=3;Xa.unstable_Profiling=null;Xa.unstable_UserBlockingPriority=2;Xa.unstable_cancelCallback=function(e){e.callback=null};Xa.unstable_continueExecution=function(){va||po||(va=!0,Js(Ys))};Xa.unstable_forceFrameRate=function(e){0>e||125<e?console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"):Fi=0<e?Math.floor(1000/e):5};Xa.unstable_getCurrentPriorityLevel=function(){return Ae};Xa.unstable_getFirstCallbackNode=function(){return it(Ct)};Xa.unstable_next=function(e){switch(Ae){case 1:case 2:case 3:var t=3;break;default:t=Ae}var a=Ae;Ae=t;try{return e()}finally{Ae=a}};Xa.unstable_pauseExecution=function(){};Xa.unstable_requestPaint=function(){};Xa.unstable_runWithPriority=function(e,t){switch(e){case 1:case 2:case 3:case 4:case 5:break;default:e=3}var a=Ae;Ae=e;try{return t()}finally{Ae=a}};Xa.unstable_scheduleCallback=function(e,t,a){var n=Xa.unstable_now();switch(typeof a==="object"&&a!==null?(a=a.delay,a=typeof a==="number"&&0<a?n+a:n):a=n,e){case 1:var r=-1;break;case 2:r=250;break;case 5:r=1073741823;break;case 4:r=1e4;break;default:r=5000}return r=a+r,e={id:fm++,callback:t,priorityLevel:e,startTime:a,expirationTime:r,sortIndex:-1},a>n?(e.sortIndex=a,js(Ht,e),it(Ct)===null&&e===it(Ht)&&(Dn?(Ri(Bn),Bn=-1):Dn=!0,el(Qs,a-n))):(e.sortIndex=r,js(Ct,e),va||po||(va=!0,Js(Ys))),e};Xa.unstable_shouldYield=Di;Xa.unstable_wrapCallback=function(e){var t=Ae;return function(){var a=Ae;Ae=t;try{return e.apply(this,arguments)}finally{Ae=a}}}});function k(e){for(var t="https://reactjs.org/docs/error-decoder.html?invariant="+e,a=1;a<arguments.length;a++)t+="&args[]="+encodeURIComponent(arguments[a]);return"Minified React error #"+e+"; visit "+t+" for the full message or use the non-minified dev environment for full errors and additional helpful warnings."}function za(e,t){mn(e,t),mn(e+"Capture",t)}function mn(e,t){ur[e]=t;for(e=0;e<t.length;e++)Nd.add(t[e])}function Rm(e){if(Il.call(_i,e))return!0;if(Il.call(Ei,e))return!1;if(Tm.test(e))return _i[e]=!0;return Ei[e]=!0,!1}function Fm(e,t,a,n){if(a!==null&&a.type===0)return!1;switch(typeof t){case"function":case"symbol":return!0;case"boolean":if(n)return!1;if(a!==null)return!a.acceptsBooleans;return e=e.toLowerCase().slice(0,5),e!=="data-"&&e!=="aria-";default:return!1}}function zm(e,t,a,n){if(t===null||typeof t>"u"||Fm(e,t,a,n))return!0;if(n)return!1;if(a!==null)switch(a.type){case 3:return!t;case 4:return t===!1;case 5:return isNaN(t);case 6:return isNaN(t)||1>t}return!1}function Oe(e,t,a,n,r,o,s){this.acceptsBooleans=t===2||t===3||t===4,this.attributeName=n,this.attributeNamespace=r,this.mustUseProperty=a,this.propertyName=e,this.type=t,this.sanitizeURL=o,this.removeEmptyString=s}function xu(e){return e[1].toUpperCase()}function Lu(e,t,a,n){var r=Me.hasOwnProperty(t)?Me[t]:null;if(r!==null?r.type!==0:n||!(2<t.length)||t[0]!=="o"&&t[0]!=="O"||t[1]!=="n"&&t[1]!=="N")zm(t,a,r,n)&&(a=null),n||r===null?Rm(t)&&(a===null?e.removeAttribute(t):e.setAttribute(t,""+a)):r.mustUseProperty?e[r.propertyName]=a===null?r.type===3?!1:"":a:(t=r.attributeName,n=r.attributeNamespace,a===null?e.removeAttribute(t):(r=r.type,a=r===3||r===4&&a===!0?"":""+a,n?e.setAttributeNS(n,t,a):e.setAttribute(t,a)))}function En(e){if(e===null||typeof e!=="object")return null;return e=Oi&&e[Oi]||e["@@iterator"],typeof e==="function"?e:null}function Vn(e){if(tl===void 0)try{throw Error()}catch(a){var t=a.stack.trim().match(/\n( *(at )?)/);tl=t&&t[1]||""}return`
`+tl+e}function nl(e,t){if(!e||al)return"";al=!0;var a=Error.prepareStackTrace;Error.prepareStackTrace=void 0;try{if(t)if(t=function(){throw Error()},Object.defineProperty(t.prototype,"props",{set:function(){throw Error()}}),typeof Reflect==="object"&&Reflect.construct){try{Reflect.construct(t,[])}catch(c){var n=c}Reflect.construct(e,[],t)}else{try{t.call()}catch(c){n=c}e.call(t.prototype)}else{try{throw Error()}catch(c){n=c}e()}}catch(c){if(c&&n&&typeof c.stack==="string"){for(var r=c.stack.split(`
`),o=n.stack.split(`
`),s=r.length-1,l=o.length-1;1<=s&&0<=l&&r[s]!==o[l];)l--;for(;1<=s&&0<=l;s--,l--)if(r[s]!==o[l]){if(s!==1||l!==1)do if(s--,l--,0>l||r[s]!==o[l]){var u=`
`+r[s].replace(" at new "," at ");return e.displayName&&u.includes("<anonymous>")&&(u=u.replace("<anonymous>",e.displayName)),u}while(1<=s&&0<=l);break}}}finally{al=!1,Error.prepareStackTrace=a}return(e=e?e.displayName||e.name:"")?Vn(e):""}function Dm(e){switch(e.tag){case 5:return Vn(e.type);case 16:return Vn("Lazy");case 13:return Vn("Suspense");case 19:return Vn("SuspenseList");case 0:case 2:case 15:return e=nl(e.type,!1),e;case 11:return e=nl(e.type.render,!1),e;case 1:return e=nl(e.type,!0),e;default:return""}}function Pl(e){if(e==null)return null;if(typeof e==="function")return e.displayName||e.name||null;if(typeof e==="string")return e;switch(e){case Qa:return"Fragment";case Wn:return"Portal";case kl:return"Profiler";case yu:return"StrictMode";case Cl:return"Suspense";case Sl:return"SuspenseList"}if(typeof e==="object")switch(e.$$typeof){case qd:return(e.displayName||"Context")+".Consumer";case Ud:return(e._context.displayName||"Context")+".Provider";case vu:var t=e.render;return e=e.displayName,e||(e=t.displayName||t.name||"",e=e!==""?"ForwardRef("+e+")":"ForwardRef"),e;case wu:return t=e.displayName||null,t!==null?t:Pl(e.type)||"Memo";case Vt:t=e._payload,e=e._init;try{return Pl(e(t))}catch(a){}}return null}function Bm(e){var t=e.type;switch(e.tag){case 24:return"Cache";case 9:return(t.displayName||"Context")+".Consumer";case 10:return(t._context.displayName||"Context")+".Provider";case 18:return"DehydratedFragment";case 11:return e=t.render,e=e.displayName||e.name||"",t.displayName||(e!==""?"ForwardRef("+e+")":"ForwardRef");case 7:return"Fragment";case 5:return t;case 4:return"Portal";case 3:return"Root";case 6:return"Text";case 16:return Pl(t);case 8:return t===yu?"StrictMode":"Mode";case 22:return"Offscreen";case 12:return"Profiler";case 21:return"Scope";case 13:return"Suspense";case 19:return"SuspenseList";case 25:return"TracingMarker";case 1:case 0:case 17:case 2:case 14:case 15:if(typeof t==="function")return t.displayName||t.name||null;if(typeof t==="string")return t}return null}function ra(e){switch(typeof e){case"boolean":case"number":case"string":case"undefined":return e;case"object":return e;default:return""}}function Wd(e){var t=e.type;return(e=e.nodeName)&&e.toLowerCase()==="input"&&(t==="checkbox"||t==="radio")}function Em(e){var t=Wd(e)?"checked":"value",a=Object.getOwnPropertyDescriptor(e.constructor.prototype,t),n=""+e[t];if(!e.hasOwnProperty(t)&&typeof a<"u"&&typeof a.get==="function"&&typeof a.set==="function"){var{get:r,set:o}=a;return Object.defineProperty(e,t,{configurable:!0,get:function(){return r.call(this)},set:function(s){n=""+s,o.call(this,s)}}),Object.defineProperty(e,t,{enumerable:a.enumerable}),{getValue:function(){return n},setValue:function(s){n=""+s},stopTracking:function(){e._valueTracker=null,delete e[t]}}}}function go(e){e._valueTracker||(e._valueTracker=Em(e))}function Vd(e){if(!e)return!1;var t=e._valueTracker;if(!t)return!0;var a=t.getValue(),n="";return e&&(n=Wd(e)?e.checked?"true":"false":e.value),e=n,e!==a?(t.setValue(e),!0):!1}function qo(e){if(e=e||(typeof document<"u"?document:void 0),typeof e>"u")return null;try{return e.activeElement||e.body}catch(t){return e.body}}function bl(e,t){var a=t.checked;return le({},t,{defaultChecked:void 0,defaultValue:void 0,value:void 0,checked:a!=null?a:e._wrapperState.initialChecked})}function Ni(e,t){var a=t.defaultValue==null?"":t.defaultValue,n=t.checked!=null?t.checked:t.defaultChecked;a=ra(t.value!=null?t.value:a),e._wrapperState={initialChecked:n,initialValue:a,controlled:t.type==="checkbox"||t.type==="radio"?t.checked!=null:t.value!=null}}function Gd(e,t){t=t.checked,t!=null&&Lu(e,"checked",t,!1)}function Ml(e,t){Gd(e,t);var a=ra(t.value),n=t.type;if(a!=null)if(n==="number"){if(a===0&&e.value===""||e.value!=a)e.value=""+a}else e.value!==""+a&&(e.value=""+a);else if(n==="submit"||n==="reset"){e.removeAttribute("value");return}t.hasOwnProperty("value")?Al(e,t.type,a):t.hasOwnProperty("defaultValue")&&Al(e,t.type,ra(t.defaultValue)),t.checked==null&&t.defaultChecked!=null&&(e.defaultChecked=!!t.defaultChecked)}function Ui(e,t,a){if(t.hasOwnProperty("value")||t.hasOwnProperty("defaultValue")){var n=t.type;if(!(n!=="submit"&&n!=="reset"||t.value!==void 0&&t.value!==null))return;t=""+e._wrapperState.initialValue,a||t===e.value||(e.value=t),e.defaultValue=t}a=e.name,a!==""&&(e.name=""),e.defaultChecked=!!e._wrapperState.initialChecked,a!==""&&(e.name=a)}function Al(e,t,a){if(t!=="number"||qo(e.ownerDocument)!==e)a==null?e.defaultValue=""+e._wrapperState.initialValue:e.defaultValue!==""+a&&(e.defaultValue=""+a)}function ln(e,t,a,n){if(e=e.options,t){t={};for(var r=0;r<a.length;r++)t["$"+a[r]]=!0;for(a=0;a<e.length;a++)r=t.hasOwnProperty("$"+e[a].value),e[a].selected!==r&&(e[a].selected=r),r&&n&&(e[a].defaultSelected=!0)}else{a=""+ra(a),t=null;for(r=0;r<e.length;r++){if(e[r].value===a){e[r].selected=!0,n&&(e[r].defaultSelected=!0);return}t!==null||e[r].disabled||(t=e[r])}t!==null&&(t.selected=!0)}}function Tl(e,t){if(t.dangerouslySetInnerHTML!=null)throw Error(k(91));return le({},t,{value:void 0,defaultValue:void 0,children:""+e._wrapperState.initialValue})}function qi(e,t){var a=t.value;if(a==null){if(a=t.children,t=t.defaultValue,a!=null){if(t!=null)throw Error(k(92));if(Gn(a)){if(1<a.length)throw Error(k(93));a=a[0]}t=a}t==null&&(t=""),a=t}e._wrapperState={initialValue:ra(a)}}function jd(e,t){var a=ra(t.value),n=ra(t.defaultValue);a!=null&&(a=""+a,a!==e.value&&(e.value=a),t.defaultValue==null&&e.defaultValue!==a&&(e.defaultValue=a)),n!=null&&(e.defaultValue=""+n)}function Hi(e){var t=e.textContent;t===e._wrapperState.initialValue&&t!==""&&t!==null&&(e.value=t)}function Kd(e){switch(e){case"svg":return"http://www.w3.org/2000/svg";case"math":return"http://www.w3.org/1998/Math/MathML";default:return"http://www.w3.org/1999/xhtml"}}function Rl(e,t){return e==null||e==="http://www.w3.org/1999/xhtml"?Kd(t):e==="http://www.w3.org/2000/svg"&&t==="foreignObject"?"http://www.w3.org/1999/xhtml":e}function ir(e,t){if(t){var a=e.firstChild;if(a&&a===e.lastChild&&a.nodeType===3){a.nodeValue=t;return}}e.textContent=t}function $d(e,t,a){return t==null||typeof t==="boolean"||t===""?"":a||typeof t!=="number"||t===0||Jn.hasOwnProperty(e)&&Jn[e]?(""+t).trim():t+"px"}function Zd(e,t){e=e.style;for(var a in t)if(t.hasOwnProperty(a)){var n=a.indexOf("--")===0,r=$d(a,t[a],n);a==="float"&&(a="cssFloat"),n?e.setProperty(a,r):e[a]=r}}function Fl(e,t){if(t){if(Om[e]&&(t.children!=null||t.dangerouslySetInnerHTML!=null))throw Error(k(137,e));if(t.dangerouslySetInnerHTML!=null){if(t.children!=null)throw Error(k(60));if(typeof t.dangerouslySetInnerHTML!=="object"||!("__html"in t.dangerouslySetInnerHTML))throw Error(k(61))}if(t.style!=null&&typeof t.style!=="object")throw Error(k(62))}}function zl(e,t){if(e.indexOf("-")===-1)return typeof t.is==="string";switch(e){case"annotation-xml":case"color-profile":case"font-face":case"font-face-src":case"font-face-uri":case"font-face-format":case"font-face-name":case"missing-glyph":return!1;default:return!0}}function Iu(e){return e=e.target||e.srcElement||window,e.correspondingUseElement&&(e=e.correspondingUseElement),e.nodeType===3?e.parentNode:e}function Wi(e){if(e=ms(e)){if(typeof Bl!=="function")throw Error(k(280));var t=e.stateNode;t&&(t=zu(t),Bl(e.stateNode,e.type,t))}}function Nm(e){un?dn?dn.push(e):dn=[e]:un=e}function Um(){if(un){var e=un,t=dn;if(dn=un=null,Wi(e),t)for(e=0;e<t.length;e++)Wi(t[e])}}function Qd(e,t){return e(t)}function Yd(){}function Jd(e,t,a){if(rl)return e(t,a);rl=!0;try{return Qd(e,t,a)}finally{if(rl=!1,un!==null||dn!==null)Yd(),Um()}}function dr(e,t){var a=e.stateNode;if(a===null)return null;var n=zu(a);if(n===null)return null;a=n[t];e:switch(t){case"onClick":case"onClickCapture":case"onDoubleClick":case"onDoubleClickCapture":case"onMouseDown":case"onMouseDownCapture":case"onMouseMove":case"onMouseMoveCapture":case"onMouseUp":case"onMouseUpCapture":case"onMouseEnter":(n=!n.disabled)||(e=e.type,n=!(e==="button"||e==="input"||e==="select"||e==="textarea")),e=!n;break e;default:e=!1}if(e)return null;if(a&&typeof a!=="function")throw Error(k(231,t,typeof a));return a}function qm(e,t,a,n,r,o,s,l,u){var c=Array.prototype.slice.call(arguments,3);try{t.apply(a,c)}catch(m){this.onError(m)}}function Wm(e,t,a,n,r,o,s,l,u){er=!1,Ho=null,qm.apply(Hm,arguments)}function Vm(e,t,a,n,r,o,s,l,u){if(Wm.apply(this,arguments),er){if(er){var c=Ho;er=!1,Ho=null}else throw Error(k(198));Wo||(Wo=!0,_l=c)}}function Da(e){var t=e,a=e;if(e.alternate)for(;t.return;)t=t.return;else{e=t;do t=e,(t.flags&4098)!==0&&(a=t.return),e=t.return;while(e)}return t.tag===3?a:null}function ef(e){if(e.tag===13){var t=e.memoizedState;if(t===null&&(e=e.alternate,e!==null&&(t=e.memoizedState)),t!==null)return t.dehydrated}return null}function Vi(e){if(Da(e)!==e)throw Error(k(188))}function Gm(e){var t=e.alternate;if(!t){if(t=Da(e),t===null)throw Error(k(188));return t!==e?null:e}for(var a=e,n=t;;){var r=a.return;if(r===null)break;var o=r.alternate;if(o===null){if(n=r.return,n!==null){a=n;continue}break}if(r.child===o.child){for(o=r.child;o;){if(o===a)return Vi(r),e;if(o===n)return Vi(r),t;o=o.sibling}throw Error(k(188))}if(a.return!==n.return)a=r,n=o;else{for(var s=!1,l=r.child;l;){if(l===a){s=!0,a=r,n=o;break}if(l===n){s=!0,n=r,a=o;break}l=l.sibling}if(!s){for(l=o.child;l;){if(l===a){s=!0,a=o,n=r;break}if(l===n){s=!0,n=o,a=r;break}l=l.sibling}if(!s)throw Error(k(189))}}if(a.alternate!==n)throw Error(k(190))}if(a.tag!==3)throw Error(k(188));return a.stateNode.current===a?e:t}function jm(e){return e=Gm(e),e!==null?tf(e):null}function tf(e){if(e.tag===5||e.tag===6)return e;for(e=e.child;e!==null;){var t=tf(e);if(t!==null)return t;e=e.sibling}return null}function Qm(e){if(Mt&&typeof Mt.onCommitFiberRoot==="function")try{Mt.onCommitFiberRoot(ds,e,void 0,(e.current.flags&128)===128)}catch(t){}}function eh(e){return e>>>=0,e===0?32:31-(Ym(e)/Jm|0)|0}function jn(e){switch(e&-e){case 1:return 1;case 2:return 2;case 4:return 4;case 8:return 8;case 16:return 16;case 32:return 32;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return e&4194240;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return e&130023424;case 134217728:return 134217728;case 268435456:return 268435456;case 536870912:return 536870912;case 1073741824:return 1073741824;default:return e}}function Go(e,t){var a=e.pendingLanes;if(a===0)return 0;var n=0,r=e.suspendedLanes,o=e.pingedLanes,s=a&268435455;if(s!==0){var l=s&~r;l!==0?n=jn(l):(o&=s,o!==0&&(n=jn(o)))}else s=a&~r,s!==0?n=jn(s):o!==0&&(n=jn(o));if(n===0)return 0;if(t!==0&&t!==n&&(t&r)===0&&(r=n&-n,o=t&-t,r>=o||r===16&&(o&4194240)!==0))return t;if((n&4)!==0&&(n|=a&16),t=e.entangledLanes,t!==0)for(e=e.entanglements,t&=n;0<t;)a=31-mt(t),r=1<<a,n|=e[a],t&=~r;return n}function th(e,t){switch(e){case 1:case 2:case 4:return t+250;case 8:case 16:case 32:case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return t+5000;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return-1;case 134217728:case 268435456:case 536870912:case 1073741824:return-1;default:return-1}}function ah(e,t){for(var{suspendedLanes:a,pingedLanes:n,expirationTimes:r,pendingLanes:o}=e;0<o;){var s=31-mt(o),l=1<<s,u=r[s];if(u===-1){if((l&a)===0||(l&n)!==0)r[s]=th(l,t)}else u<=t&&(e.expiredLanes|=l);o&=~l}}function Ol(e){return e=e.pendingLanes&-1073741825,e!==0?e:e&1073741824?1073741824:0}function of(){var e=Lo;return Lo<<=1,(Lo&4194240)===0&&(Lo=64),e}function ol(e){for(var t=[],a=0;31>a;a++)t.push(e);return t}function Cr(e,t,a){e.pendingLanes|=t,t!==536870912&&(e.suspendedLanes=0,e.pingedLanes=0),e=e.eventTimes,t=31-mt(t),e[t]=a}function nh(e,t){var a=e.pendingLanes&~t;e.pendingLanes=t,e.suspendedLanes=0,e.pingedLanes=0,e.expiredLanes&=t,e.mutableReadLanes&=t,e.entangledLanes&=t,t=e.entanglements;var n=e.eventTimes;for(e=e.expirationTimes;0<a;){var r=31-mt(a),o=1<<r;t[r]=0,n[r]=-1,e[r]=-1,a&=~o}}function Cu(e,t){var a=e.entangledLanes|=t;for(e=e.entanglements;a;){var n=31-mt(a),r=1<<n;r&t|e[n]&t&&(e[n]|=t),a&=~r}}function sf(e){return e&=-e,1<e?4<e?(e&268435455)!==0?16:536870912:4:1}function ji(e,t){switch(e){case"focusin":case"focusout":Zt=null;break;case"dragenter":case"dragleave":Qt=null;break;case"mouseover":case"mouseout":Yt=null;break;case"pointerover":case"pointerout":fr.delete(t.pointerId);break;case"gotpointercapture":case"lostpointercapture":cr.delete(t.pointerId)}}function _n(e,t,a,n,r,o){if(e===null||e.nativeEvent!==o)return e={blockedOn:t,domEventName:a,eventSystemFlags:n,nativeEvent:o,targetContainers:[r]},t!==null&&(t=ms(t),t!==null&&Su(t)),e;return e.eventSystemFlags|=n,t=e.targetContainers,r!==null&&t.indexOf(r)===-1&&t.push(r),e}function oh(e,t,a,n,r){switch(t){case"focusin":return Zt=_n(Zt,e,t,a,n,r),!0;case"dragenter":return Qt=_n(Qt,e,t,a,n,r),!0;case"mouseover":return Yt=_n(Yt,e,t,a,n,r),!0;case"pointerover":var o=r.pointerId;return fr.set(o,_n(fr.get(o)||null,e,t,a,n,r)),!0;case"gotpointercapture":return o=r.pointerId,cr.set(o,_n(cr.get(o)||null,e,t,a,n,r)),!0}return!1}function cf(e){var t=Ca(e.target);if(t!==null){var a=Da(t);if(a!==null){if(t=a.tag,t===13){if(t=ef(a),t!==null){e.blockedOn=t,ff(e.priority,function(){uf(a)});return}}else if(t===3&&a.stateNode.current.memoizedState.isDehydrated){e.blockedOn=a.tag===3?a.stateNode.containerInfo:null;return}}}e.blockedOn=null}function To(e){if(e.blockedOn!==null)return!1;for(var t=e.targetContainers;0<t.length;){var a=Ul(e.domEventName,e.eventSystemFlags,t[0],e.nativeEvent);if(a===null){a=e.nativeEvent;var n=new a.constructor(a.type,a);Dl=n,a.target.dispatchEvent(n),Dl=null}else return t=ms(a),t!==null&&Su(t),e.blockedOn=a,!1;t.shift()}return!0}function Ki(e,t,a){To(e)&&a.delete(t)}function sh(){Nl=!1,Zt!==null&&To(Zt)&&(Zt=null),Qt!==null&&To(Qt)&&(Qt=null),Yt!==null&&To(Yt)&&(Yt=null),fr.forEach(Ki),cr.forEach(Ki)}function On(e,t){e.blockedOn===t&&(e.blockedOn=null,Nl||(Nl=!0,re.unstable_scheduleCallback(re.unstable_NormalPriority,sh)))}function pr(e){function t(r){return On(r,e)}if(0<vo.length){On(vo[0],e);for(var a=1;a<vo.length;a++){var n=vo[a];n.blockedOn===e&&(n.blockedOn=null)}}Zt!==null&&On(Zt,e),Qt!==null&&On(Qt,e),Yt!==null&&On(Yt,e),fr.forEach(t),cr.forEach(t);for(a=0;a<jt.length;a++)n=jt[a],n.blockedOn===e&&(n.blockedOn=null);for(;0<jt.length&&(a=jt[0],a.blockedOn===null);)cf(a),a.blockedOn===null&&jt.shift()}function lh(e,t,a,n){var r=K,o=fn.transition;fn.transition=null;try{K=1,Pu(e,t,a,n)}finally{K=r,fn.transition=o}}function uh(e,t,a,n){var r=K,o=fn.transition;fn.transition=null;try{K=4,Pu(e,t,a,n)}finally{K=r,fn.transition=o}}function Pu(e,t,a,n){if(jo){var r=Ul(e,t,a,n);if(r===null)fl(e,t,n,Ko,a),ji(e,n);else if(oh(r,e,t,a,n))n.stopPropagation();else if(ji(e,n),t&4&&-1<rh.indexOf(e)){for(;r!==null;){var o=ms(r);if(o!==null&&lf(o),o=Ul(e,t,a,n),o===null&&fl(e,t,n,Ko,a),o===r)break;r=o}r!==null&&n.stopPropagation()}else fl(e,t,n,null,a)}}function Ul(e,t,a,n){if(Ko=null,e=Iu(n),e=Ca(e),e!==null)if(t=Da(e),t===null)e=null;else if(a=t.tag,a===13){if(e=ef(t),e!==null)return e;e=null}else if(a===3){if(t.stateNode.current.memoizedState.isDehydrated)return t.tag===3?t.stateNode.containerInfo:null;e=null}else t!==e&&(e=null);return Ko=e,null}function pf(e){switch(e){case"cancel":case"click":case"close":case"contextmenu":case"copy":case"cut":case"auxclick":case"dblclick":case"dragend":case"dragstart":case"drop":case"focusin":case"focusout":case"input":case"invalid":case"keydown":case"keypress":case"keyup":case"mousedown":case"mouseup":case"paste":case"pause":case"play":case"pointercancel":case"pointerdown":case"pointerup":case"ratechange":case"reset":case"resize":case"seeked":case"submit":case"touchcancel":case"touchend":case"touchstart":case"volumechange":case"change":case"selectionchange":case"textInput":case"compositionstart":case"compositionend":case"compositionupdate":case"beforeblur":case"afterblur":case"beforeinput":case"blur":case"fullscreenchange":case"focus":case"hashchange":case"popstate":case"select":case"selectstart":return 1;case"drag":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"mousemove":case"mouseout":case"mouseover":case"pointermove":case"pointerout":case"pointerover":case"scroll":case"toggle":case"touchmove":case"wheel":case"mouseenter":case"mouseleave":case"pointerenter":case"pointerleave":return 4;case"message":switch($m()){case ku:return 1;case nf:return 4;case Vo:case Zm:return 16;case rf:return 536870912;default:return 16}default:return 16}}function mf(){if(Ro)return Ro;var e,t=bu,a=t.length,n,r="value"in Xt?Xt.value:Xt.textContent,o=r.length;for(e=0;e<a&&t[e]===r[e];e++);var s=a-e;for(n=1;n<=s&&t[a-n]===r[o-n];n++);return Ro=r.slice(e,1<n?1-n:void 0)}function Fo(e){var t=e.keyCode;return"charCode"in e?(e=e.charCode,e===0&&t===13&&(e=13)):e=t,e===10&&(e=13),32<=e||e===13?e:0}function wo(){return!0}function Xi(){return!1}function Xe(e){function t(a,n,r,o,s){this._reactName=a,this._targetInst=r,this.type=n,this.nativeEvent=o,this.target=s,this.currentTarget=null;for(var l in e)e.hasOwnProperty(l)&&(a=e[l],this[l]=a?a(o):o[l]);return this.isDefaultPrevented=(o.defaultPrevented!=null?o.defaultPrevented:o.returnValue===!1)?wo:Xi,this.isPropagationStopped=Xi,this}return le(t.prototype,{preventDefault:function(){this.defaultPrevented=!0;var a=this.nativeEvent;a&&(a.preventDefault?a.preventDefault():typeof a.returnValue!=="unknown"&&(a.returnValue=!1),this.isDefaultPrevented=wo)},stopPropagation:function(){var a=this.nativeEvent;a&&(a.stopPropagation?a.stopPropagation():typeof a.cancelBubble!=="unknown"&&(a.cancelBubble=!0),this.isPropagationStopped=wo)},persist:function(){},isPersistent:wo}),t}function wh(e){var t=this.nativeEvent;return t.getModifierState?t.getModifierState(e):(e=vh[e])?!!t[e]:!1}function Au(){return wh}function gf(e,t){switch(e){case"keyup":return Rh.indexOf(t.keyCode)!==-1;case"keydown":return t.keyCode!==229;case"keypress":case"mousedown":case"focusout":return!0;default:return!1}}function xf(e){return e=e.detail,typeof e==="object"&&"data"in e?e.data:null}function zh(e,t){switch(e){case"compositionend":return xf(t);case"keypress":if(t.which!==32)return null;return Ji=!0,Yi;case"textInput":return e=t.data,e===Yi&&Ji?null:e;default:return null}}function Dh(e,t){if(Ya)return e==="compositionend"||!Tu&&gf(e,t)?(e=mf(),Ro=bu=Xt=null,Ya=!1,e):null;switch(e){case"paste":return null;case"keypress":if(!(t.ctrlKey||t.altKey||t.metaKey)||t.ctrlKey&&t.altKey){if(t.char&&1<t.char.length)return t.char;if(t.which)return String.fromCharCode(t.which)}return null;case"compositionend":return hf&&t.locale!=="ko"?null:t.data;default:return null}}function ed(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t==="input"?!!Bh[e.type]:t==="textarea"?!0:!1}function Lf(e,t,a,n){Nm(n),t=Xo(t,"onChange"),0<t.length&&(a=new Mu("onChange","change",null,a,n),e.push({event:a,listeners:t}))}function Eh(e){Af(e,0)}function cs(e){var t=Yn(e);if(Vd(t))return e}function _h(e,t){if(e==="change")return t}function td(){ar&&(ar.detachEvent("onpropertychange",vf),mr=ar=null)}function vf(e){if(e.propertyName==="value"&&cs(mr)){var t=[];Lf(t,mr,e,Iu(e)),Jd(Eh,t)}}function Oh(e,t,a){e==="focusin"?(td(),ar=t,mr=a,ar.attachEvent("onpropertychange",vf)):e==="focusout"&&td()}function Nh(e){if(e==="selectionchange"||e==="keyup"||e==="keydown")return cs(mr)}function Uh(e,t){if(e==="click")return cs(t)}function qh(e,t){if(e==="input"||e==="change")return cs(t)}function Hh(e,t){return e===t&&(e!==0||1/e===1/t)||e!==e&&t!==t}function hr(e,t){if(gt(e,t))return!0;if(typeof e!=="object"||e===null||typeof t!=="object"||t===null)return!1;var a=Object.keys(e),n=Object.keys(t);if(a.length!==n.length)return!1;for(n=0;n<a.length;n++){var r=a[n];if(!Il.call(t,r)||!gt(e[r],t[r]))return!1}return!0}function ad(e){for(;e&&e.firstChild;)e=e.firstChild;return e}function nd(e,t){var a=ad(e);e=0;for(var n;a;){if(a.nodeType===3){if(n=e+a.textContent.length,e<=t&&n>=t)return{node:a,offset:t-e};e=n}e:{for(;a;){if(a.nextSibling){a=a.nextSibling;break e}a=a.parentNode}a=void 0}a=ad(a)}}function wf(e,t){return e&&t?e===t?!0:e&&e.nodeType===3?!1:t&&t.nodeType===3?wf(e,t.parentNode):("contains"in e)?e.contains(t):e.compareDocumentPosition?!!(e.compareDocumentPosition(t)&16):!1:!1}function If(){for(var e=window,t=qo();t instanceof e.HTMLIFrameElement;){try{var a=typeof t.contentWindow.location.href==="string"}catch(n){a=!1}if(a)e=t.contentWindow;else break;t=qo(e.document)}return t}function Ru(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t&&(t==="input"&&(e.type==="text"||e.type==="search"||e.type==="tel"||e.type==="url"||e.type==="password")||t==="textarea"||e.contentEditable==="true")}function Wh(e){var t=If(),a=e.focusedElem,n=e.selectionRange;if(t!==a&&a&&a.ownerDocument&&wf(a.ownerDocument.documentElement,a)){if(n!==null&&Ru(a)){if(t=n.start,e=n.end,e===void 0&&(e=t),"selectionStart"in a)a.selectionStart=t,a.selectionEnd=Math.min(e,a.value.length);else if(e=(t=a.ownerDocument||document)&&t.defaultView||window,e.getSelection){e=e.getSelection();var r=a.textContent.length,o=Math.min(n.start,r);n=n.end===void 0?o:Math.min(n.end,r),!e.extend&&o>n&&(r=n,n=o,o=r),r=nd(a,o);var s=nd(a,n);r&&s&&(e.rangeCount!==1||e.anchorNode!==r.node||e.anchorOffset!==r.offset||e.focusNode!==s.node||e.focusOffset!==s.offset)&&(t=t.createRange(),t.setStart(r.node,r.offset),e.removeAllRanges(),o>n?(e.addRange(t),e.extend(s.node,s.offset)):(t.setEnd(s.node,s.offset),e.addRange(t)))}}t=[];for(e=a;e=e.parentNode;)e.nodeType===1&&t.push({element:e,left:e.scrollLeft,top:e.scrollTop});typeof a.focus==="function"&&a.focus();for(a=0;a<t.length;a++)e=t[a],e.element.scrollLeft=e.left,e.element.scrollTop=e.top}}function rd(e,t,a){var n=a.window===a?a.document:a.nodeType===9?a:a.ownerDocument;Hl||Ja==null||Ja!==qo(n)||(n=Ja,("selectionStart"in n)&&Ru(n)?n={start:n.selectionStart,end:n.selectionEnd}:(n=(n.ownerDocument&&n.ownerDocument.defaultView||window).getSelection(),n={anchorNode:n.anchorNode,anchorOffset:n.anchorOffset,focusNode:n.focusNode,focusOffset:n.focusOffset}),nr&&hr(nr,n)||(nr=n,n=Xo(ql,"onSelect"),0<n.length&&(t=new Mu("onSelect","select",null,t,a),e.push({event:t,listeners:n}),t.target=Ja)))}function Io(e,t){var a={};return a[e.toLowerCase()]=t.toLowerCase(),a["Webkit"+e]="webkit"+t,a["Moz"+e]="moz"+t,a}function ps(e){if(il[e])return il[e];if(!en[e])return e;var t=en[e],a;for(a in t)if(t.hasOwnProperty(a)&&a in kf)return il[e]=t[a];return e}function sa(e,t){Mf.set(e,t),za(t,[e])}function sd(e,t,a){var n=e.type||"unknown-event";e.currentTarget=a,Vm(n,t,void 0,e),e.currentTarget=null}function Af(e,t){t=(t&4)!==0;for(var a=0;a<e.length;a++){var n=e[a],r=n.event;n=n.listeners;e:{var o=void 0;if(t)for(var s=n.length-1;0<=s;s--){var l=n[s],u=l.instance,c=l.currentTarget;if(l=l.listener,u!==o&&r.isPropagationStopped())break e;sd(r,l,c),o=u}else for(s=0;s<n.length;s++){if(l=n[s],u=l.instance,c=l.currentTarget,l=l.listener,u!==o&&r.isPropagationStopped())break e;sd(r,l,c),o=u}}}if(Wo)throw e=_l,Wo=!1,_l=null,e}function te(e,t){var a=t[$l];a===void 0&&(a=t[$l]=new Set);var n=e+"__bubble";a.has(n)||(Tf(t,e,2,!1),a.add(n))}function dl(e,t,a){var n=0;t&&(n|=4),Tf(a,e,n,t)}function Fu(e){if(!e[ko]){e[ko]=!0,Nd.forEach(function(a){a!=="selectionchange"&&(Gh.has(a)||dl(a,!1,e),dl(a,!0,e))});var t=e.nodeType===9?e:e.ownerDocument;t===null||t[ko]||(t[ko]=!0,dl("selectionchange",!1,t))}}function Tf(e,t,a,n){switch(pf(t)){case 1:var r=lh;break;case 4:r=uh;break;default:r=Pu}a=r.bind(null,t,a,e),r=void 0,!El||t!=="touchstart"&&t!=="touchmove"&&t!=="wheel"||(r=!0),n?r!==void 0?e.addEventListener(t,a,{capture:!0,passive:r}):e.addEventListener(t,a,!0):r!==void 0?e.addEventListener(t,a,{passive:r}):e.addEventListener(t,a,!1)}function fl(e,t,a,n,r){var o=n;if((t&1)===0&&(t&2)===0&&n!==null)e:for(;;){if(n===null)return;var s=n.tag;if(s===3||s===4){var l=n.stateNode.containerInfo;if(l===r||l.nodeType===8&&l.parentNode===r)break;if(s===4)for(s=n.return;s!==null;){var u=s.tag;if(u===3||u===4){if(u=s.stateNode.containerInfo,u===r||u.nodeType===8&&u.parentNode===r)return}s=s.return}for(;l!==null;){if(s=Ca(l),s===null)return;if(u=s.tag,u===5||u===6){n=o=s;continue e}l=l.parentNode}}n=n.return}Jd(function(){var c=o,m=Iu(a),g=[];e:{var h=Mf.get(e);if(h!==void 0){var L=Mu,x=e;switch(e){case"keypress":if(Fo(a)===0)break e;case"keydown":case"keyup":L=kh;break;case"focusin":x="focus",L=ul;break;case"focusout":x="blur",L=ul;break;case"beforeblur":case"afterblur":L=ul;break;case"click":if(a.button===2)break e;case"auxclick":case"dblclick":case"mousedown":case"mousemove":case"mouseup":case"mouseout":case"mouseover":case"contextmenu":L=$i;break;case"drag":case"dragend":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"dragstart":case"drop":L=fh;break;case"touchcancel":case"touchend":case"touchmove":case"touchstart":L=Ph;break;case Cf:case Sf:case Pf:L=mh;break;case bf:L=Mh;break;case"scroll":L=ih;break;case"wheel":L=Th;break;case"copy":case"cut":case"paste":L=gh;break;case"gotpointercapture":case"lostpointercapture":case"pointercancel":case"pointerdown":case"pointermove":case"pointerout":case"pointerover":case"pointerup":L=Qi}var C=(t&4)!==0,E=!C&&e==="scroll",d=C?h!==null?h+"Capture":null:h;C=[];for(var i=c,p;i!==null;){p=i;var v=p.stateNode;if(p.tag===5&&v!==null&&(p=v,d!==null&&(v=dr(i,d),v!=null&&C.push(gr(i,v,p)))),E)break;i=i.return}0<C.length&&(h=new L(h,x,null,a,m),g.push({event:h,listeners:C}))}}if((t&7)===0){e:{if(h=e==="mouseover"||e==="pointerover",L=e==="mouseout"||e==="pointerout",h&&a!==Dl&&(x=a.relatedTarget||a.fromElement)&&(Ca(x)||x[kn]))break e;if(L||h){if(h=m.window===m?m:(h=m.ownerDocument)?h.defaultView||h.parentWindow:window,L){if(x=a.relatedTarget||a.toElement,L=c,x=x?Ca(x):null,x!==null&&(E=Da(x),x!==E||x.tag!==5&&x.tag!==6))x=null}else L=null,x=c;if(L!==x){if(C=$i,v="onMouseLeave",d="onMouseEnter",i="mouse",e==="pointerout"||e==="pointerover")C=Qi,v="onPointerLeave",d="onPointerEnter",i="pointer";if(E=L==null?h:Yn(L),p=x==null?h:Yn(x),h=new C(v,i+"leave",L,a,m),h.target=E,h.relatedTarget=p,v=null,Ca(m)===c&&(C=new C(d,i+"enter",x,a,m),C.target=p,C.relatedTarget=E,v=C),E=v,L&&x)t:{C=L,d=x,i=0;for(p=C;p;p=$a(p))i++;p=0;for(v=d;v;v=$a(v))p++;for(;0<i-p;)C=$a(C),i--;for(;0<p-i;)d=$a(d),p--;for(;i--;){if(C===d||d!==null&&C===d.alternate)break t;C=$a(C),d=$a(d)}C=null}else C=null;L!==null&&ld(g,h,L,C,!1),x!==null&&E!==null&&ld(g,E,x,C,!0)}}}e:{if(h=c?Yn(c):window,L=h.nodeName&&h.nodeName.toLowerCase(),L==="select"||L==="input"&&h.type==="file")var w=_h;else if(ed(h))if(yf)w=qh;else{w=Nh;var z=Oh}else(L=h.nodeName)&&L.toLowerCase()==="input"&&(h.type==="checkbox"||h.type==="radio")&&(w=Uh);if(w&&(w=w(e,c))){Lf(g,w,a,m);break e}z&&z(e,h,c),e==="focusout"&&(z=h._wrapperState)&&z.controlled&&h.type==="number"&&Al(h,"number",h.value)}switch(z=c?Yn(c):window,e){case"focusin":if(ed(z)||z.contentEditable==="true")Ja=z,ql=c,nr=null;break;case"focusout":nr=ql=Ja=null;break;case"mousedown":Hl=!0;break;case"contextmenu":case"mouseup":case"dragend":Hl=!1,rd(g,a,m);break;case"selectionchange":if(Vh)break;case"keydown":case"keyup":rd(g,a,m)}var D;if(Tu)e:{switch(e){case"compositionstart":var y="onCompositionStart";break e;case"compositionend":y="onCompositionEnd";break e;case"compositionupdate":y="onCompositionUpdate";break e}y=void 0}else Ya?gf(e,a)&&(y="onCompositionEnd"):e==="keydown"&&a.keyCode===229&&(y="onCompositionStart");if(y&&(hf&&a.locale!=="ko"&&(Ya||y!=="onCompositionStart"?y==="onCompositionEnd"&&Ya&&(D=mf()):(Xt=m,bu=("value"in Xt)?Xt.value:Xt.textContent,Ya=!0)),z=Xo(c,y),0<z.length&&(y=new Zi(y,e,null,a,m),g.push({event:y,listeners:z}),D?y.data=D:(D=xf(a),D!==null&&(y.data=D)))),D=Fh?zh(e,a):Dh(e,a))c=Xo(c,"onBeforeInput"),0<c.length&&(m=new Zi("onBeforeInput","beforeinput",null,a,m),g.push({event:m,listeners:c}),m.data=D)}Af(g,t)})}function gr(e,t,a){return{instance:e,listener:t,currentTarget:a}}function Xo(e,t){for(var a=t+"Capture",n=[];e!==null;){var r=e,o=r.stateNode;r.tag===5&&o!==null&&(r=o,o=dr(e,a),o!=null&&n.unshift(gr(e,o,r)),o=dr(e,t),o!=null&&n.push(gr(e,o,r))),e=e.return}return n}function $a(e){if(e===null)return null;do e=e.return;while(e&&e.tag!==5);return e?e:null}function ld(e,t,a,n,r){for(var o=t._reactName,s=[];a!==null&&a!==n;){var l=a,u=l.alternate,c=l.stateNode;if(u!==null&&u===n)break;l.tag===5&&c!==null&&(l=c,r?(u=dr(a,o),u!=null&&s.unshift(gr(a,u,l))):r||(u=dr(a,o),u!=null&&s.push(gr(a,u,l)))),a=a.return}s.length!==0&&e.push({event:t,listeners:s})}function ud(e){return(typeof e==="string"?e:""+e).replace(jh,`
`).replace(Kh,"")}function Co(e,t,a){if(t=ud(t),ud(e)!==t&&a)throw Error(k(425))}function $o(){}function Kl(e,t){return e==="textarea"||e==="noscript"||typeof t.children==="string"||typeof t.children==="number"||typeof t.dangerouslySetInnerHTML==="object"&&t.dangerouslySetInnerHTML!==null&&t.dangerouslySetInnerHTML.__html!=null}function Zh(e){setTimeout(function(){throw e})}function cl(e,t){var a=t,n=0;do{var r=a.nextSibling;if(e.removeChild(a),r&&r.nodeType===8)if(a=r.data,a==="/$"){if(n===0){e.removeChild(r),pr(t);return}n--}else a!=="$"&&a!=="$?"&&a!=="$!"||n++;a=r}while(a);pr(t)}function Jt(e){for(;e!=null;e=e.nextSibling){var t=e.nodeType;if(t===1||t===3)break;if(t===8){if(t=e.data,t==="$"||t==="$!"||t==="$?")break;if(t==="/$")return null}}return e}function dd(e){e=e.previousSibling;for(var t=0;e;){if(e.nodeType===8){var a=e.data;if(a==="$"||a==="$!"||a==="$?"){if(t===0)return e;t--}else a==="/$"&&t++}e=e.previousSibling}return null}function Ca(e){var t=e[bt];if(t)return t;for(var a=e.parentNode;a;){if(t=a[kn]||a[bt]){if(a=t.alternate,t.child!==null||a!==null&&a.child!==null)for(e=dd(e);e!==null;){if(a=e[bt])return a;e=dd(e)}return t}e=a,a=e.parentNode}return null}function ms(e){return e=e[bt]||e[kn],!e||e.tag!==5&&e.tag!==6&&e.tag!==13&&e.tag!==3?null:e}function Yn(e){if(e.tag===5||e.tag===6)return e.stateNode;throw Error(k(33))}function zu(e){return e[xr]||null}function la(e){return{current:e}}function ae(e){0>tn||(e.current=Zl[tn],Zl[tn]=null,tn--)}function Y(e,t){tn++,Zl[tn]=e.current,e.current=t}function hn(e,t){var a=e.type.contextTypes;if(!a)return oa;var n=e.stateNode;if(n&&n.__reactInternalMemoizedUnmaskedChildContext===t)return n.__reactInternalMemoizedMaskedChildContext;var r={},o;for(o in a)r[o]=t[o];return n&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=t,e.__reactInternalMemoizedMaskedChildContext=r),r}function He(e){return e=e.childContextTypes,e!==null&&e!==void 0}function Zo(){ae(qe),ae(ze)}function fd(e,t,a){if(ze.current!==oa)throw Error(k(168));Y(ze,t),Y(qe,a)}function Rf(e,t,a){var n=e.stateNode;if(t=t.childContextTypes,typeof n.getChildContext!=="function")return a;n=n.getChildContext();for(var r in n)if(!(r in t))throw Error(k(108,Bm(e)||"Unknown",r));return le({},a,n)}function Qo(e){return e=(e=e.stateNode)&&e.__reactInternalMemoizedMergedChildContext||oa,Aa=ze.current,Y(ze,e),Y(qe,qe.current),!0}function cd(e,t,a){var n=e.stateNode;if(!n)throw Error(k(169));a?(e=Rf(e,t,Aa),n.__reactInternalMemoizedMergedChildContext=e,ae(qe),ae(ze),Y(ze,e)):ae(qe),Y(qe,a)}function Ff(e){Dt===null?Dt=[e]:Dt.push(e)}function Jh(e){hs=!0,Ff(e)}function ua(){if(!pl&&Dt!==null){pl=!0;var e=0,t=K;try{var a=Dt;for(K=1;e<a.length;e++){var n=a[e];do n=n(!0);while(n!==null)}Dt=null,hs=!1}catch(r){throw Dt!==null&&(Dt=Dt.slice(e+1)),af(ku,ua),r}finally{K=t,pl=!1}}return null}function Ia(e,t){an[nn++]=Jo,an[nn++]=Yo,Yo=e,Jo=t}function zf(e,t,a){Ye[Je++]=Bt,Ye[Je++]=Et,Ye[Je++]=Ta,Ta=e;var n=Bt;e=Et;var r=32-mt(n)-1;n&=~(1<<r),a+=1;var o=32-mt(t)+r;if(30<o){var s=r-r%5;o=(n&(1<<s)-1).toString(32),n>>=s,r-=s,Bt=1<<32-mt(t)+r|a<<r|n,Et=o+e}else Bt=1<<o|a<<r|n,Et=e}function Du(e){e.return!==null&&(Ia(e,1),zf(e,1,0))}function Bu(e){for(;e===Yo;)Yo=an[--nn],an[nn]=null,Jo=an[--nn],an[nn]=null;for(;e===Ta;)Ta=Ye[--Je],Ye[Je]=null,Et=Ye[--Je],Ye[Je]=null,Bt=Ye[--Je],Ye[Je]=null}function Df(e,t){var a=et(5,null,null,0);a.elementType="DELETED",a.stateNode=t,a.return=e,t=e.deletions,t===null?(e.deletions=[a],e.flags|=16):t.push(a)}function pd(e,t){switch(e.tag){case 5:var a=e.type;return t=t.nodeType!==1||a.toLowerCase()!==t.nodeName.toLowerCase()?null:t,t!==null?(e.stateNode=t,Ke=e,je=Jt(t.firstChild),!0):!1;case 6:return t=e.pendingProps===""||t.nodeType!==3?null:t,t!==null?(e.stateNode=t,Ke=e,je=null,!0):!1;case 13:return t=t.nodeType!==8?null:t,t!==null?(a=Ta!==null?{id:Bt,overflow:Et}:null,e.memoizedState={dehydrated:t,treeContext:a,retryLane:1073741824},a=et(18,null,null,0),a.stateNode=t,a.return=e,e.child=a,Ke=e,je=null,!0):!1;default:return!1}}function Ql(e){return(e.mode&1)!==0&&(e.flags&128)===0}function Yl(e){if(ne){var t=je;if(t){var a=t;if(!pd(e,t)){if(Ql(e))throw Error(k(418));t=Jt(a.nextSibling);var n=Ke;t&&pd(e,t)?Df(n,a):(e.flags=e.flags&-4097|2,ne=!1,Ke=e)}}else{if(Ql(e))throw Error(k(418));e.flags=e.flags&-4097|2,ne=!1,Ke=e}}}function md(e){for(e=e.return;e!==null&&e.tag!==5&&e.tag!==3&&e.tag!==13;)e=e.return;Ke=e}function So(e){if(e!==Ke)return!1;if(!ne)return md(e),ne=!0,!1;var t;if((t=e.tag!==3)&&!(t=e.tag!==5)&&(t=e.type,t=t!=="head"&&t!=="body"&&!Kl(e.type,e.memoizedProps)),t&&(t=je)){if(Ql(e))throw Bf(),Error(k(418));for(;t;)Df(e,t),t=Jt(t.nextSibling)}if(md(e),e.tag===13){if(e=e.memoizedState,e=e!==null?e.dehydrated:null,!e)throw Error(k(317));e:{e=e.nextSibling;for(t=0;e;){if(e.nodeType===8){var a=e.data;if(a==="/$"){if(t===0){je=Jt(e.nextSibling);break e}t--}else a!=="$"&&a!=="$!"&&a!=="$?"||t++}e=e.nextSibling}je=null}}else je=Ke?Jt(e.stateNode.nextSibling):null;return!0}function Bf(){for(var e=je;e;)e=Jt(e.nextSibling)}function gn(){je=Ke=null,ne=!1}function Eu(e){pt===null?pt=[e]:pt.push(e)}function Un(e,t,a){if(e=a.ref,e!==null&&typeof e!=="function"&&typeof e!=="object"){if(a._owner){if(a=a._owner,a){if(a.tag!==1)throw Error(k(309));var n=a.stateNode}if(!n)throw Error(k(147,e));var r=n,o=""+e;if(t!==null&&t.ref!==null&&typeof t.ref==="function"&&t.ref._stringRef===o)return t.ref;return t=function(s){var l=r.refs;s===null?delete l[o]:l[o]=s},t._stringRef=o,t}if(typeof e!=="string")throw Error(k(284));if(!a._owner)throw Error(k(290,e))}return e}function Po(e,t){throw e=Object.prototype.toString.call(t),Error(k(31,e==="[object Object]"?"object with keys {"+Object.keys(t).join(", ")+"}":e))}function hd(e){var t=e._init;return t(e._payload)}function Ef(e){function t(d,i){if(e){var p=d.deletions;p===null?(d.deletions=[i],d.flags|=16):p.push(i)}}function a(d,i){if(!e)return null;for(;i!==null;)t(d,i),i=i.sibling;return null}function n(d,i){for(d=new Map;i!==null;)i.key!==null?d.set(i.key,i):d.set(i.index,i),i=i.sibling;return d}function r(d,i){return d=na(d,i),d.index=0,d.sibling=null,d}function o(d,i,p){if(d.index=p,!e)return d.flags|=1048576,i;if(p=d.alternate,p!==null)return p=p.index,p<i?(d.flags|=2,i):p;return d.flags|=2,i}function s(d){return e&&d.alternate===null&&(d.flags|=2),d}function l(d,i,p,v){if(i===null||i.tag!==6)return i=vl(p,d.mode,v),i.return=d,i;return i=r(i,p),i.return=d,i}function u(d,i,p,v){var w=p.type;if(w===Qa)return m(d,i,p.props.children,v,p.key);if(i!==null&&(i.elementType===w||typeof w==="object"&&w!==null&&w.$$typeof===Vt&&hd(w)===i.type))return v=r(i,p.props),v.ref=Un(d,i,p),v.return=d,v;return v=Uo(p.type,p.key,p.props,null,d.mode,v),v.ref=Un(d,i,p),v.return=d,v}function c(d,i,p,v){if(i===null||i.tag!==4||i.stateNode.containerInfo!==p.containerInfo||i.stateNode.implementation!==p.implementation)return i=wl(p,d.mode,v),i.return=d,i;return i=r(i,p.children||[]),i.return=d,i}function m(d,i,p,v,w){if(i===null||i.tag!==7)return i=Ma(p,d.mode,v,w),i.return=d,i;return i=r(i,p),i.return=d,i}function g(d,i,p){if(typeof i==="string"&&i!==""||typeof i==="number")return i=vl(""+i,d.mode,p),i.return=d,i;if(typeof i==="object"&&i!==null){switch(i.$$typeof){case ho:return p=Uo(i.type,i.key,i.props,null,d.mode,p),p.ref=Un(d,null,i),p.return=d,p;case Wn:return i=wl(i,d.mode,p),i.return=d,i;case Vt:var v=i._init;return g(d,v(i._payload),p)}if(Gn(i)||En(i))return i=Ma(i,d.mode,p,null),i.return=d,i;Po(d,i)}return null}function h(d,i,p,v){var w=i!==null?i.key:null;if(typeof p==="string"&&p!==""||typeof p==="number")return w!==null?null:l(d,i,""+p,v);if(typeof p==="object"&&p!==null){switch(p.$$typeof){case ho:return p.key===w?u(d,i,p,v):null;case Wn:return p.key===w?c(d,i,p,v):null;case Vt:return w=p._init,h(d,i,w(p._payload),v)}if(Gn(p)||En(p))return w!==null?null:m(d,i,p,v,null);Po(d,p)}return null}function L(d,i,p,v,w){if(typeof v==="string"&&v!==""||typeof v==="number")return d=d.get(p)||null,l(i,d,""+v,w);if(typeof v==="object"&&v!==null){switch(v.$$typeof){case ho:return d=d.get(v.key===null?p:v.key)||null,u(i,d,v,w);case Wn:return d=d.get(v.key===null?p:v.key)||null,c(i,d,v,w);case Vt:var z=v._init;return L(d,i,p,z(v._payload),w)}if(Gn(v)||En(v))return d=d.get(p)||null,m(i,d,v,w,null);Po(i,v)}return null}function x(d,i,p,v){for(var w=null,z=null,D=i,y=i=0,Q=null;D!==null&&y<p.length;y++){D.index>y?(Q=D,D=null):Q=D.sibling;var B=h(d,D,p[y],v);if(B===null){D===null&&(D=Q);break}e&&D&&B.alternate===null&&t(d,D),i=o(B,i,y),z===null?w=B:z.sibling=B,z=B,D=Q}if(y===p.length)return a(d,D),ne&&Ia(d,y),w;if(D===null){for(;y<p.length;y++)D=g(d,p[y],v),D!==null&&(i=o(D,i,y),z===null?w=D:z.sibling=D,z=D);return ne&&Ia(d,y),w}for(D=n(d,D);y<p.length;y++)Q=L(D,d,y,p[y],v),Q!==null&&(e&&Q.alternate!==null&&D.delete(Q.key===null?y:Q.key),i=o(Q,i,y),z===null?w=Q:z.sibling=Q,z=Q);return e&&D.forEach(function(V){return t(d,V)}),ne&&Ia(d,y),w}function C(d,i,p,v){var w=En(p);if(typeof w!=="function")throw Error(k(150));if(p=w.call(p),p==null)throw Error(k(151));for(var z=w=null,D=i,y=i=0,Q=null,B=p.next();D!==null&&!B.done;y++,B=p.next()){D.index>y?(Q=D,D=null):Q=D.sibling;var V=h(d,D,B.value,v);if(V===null){D===null&&(D=Q);break}e&&D&&V.alternate===null&&t(d,D),i=o(V,i,y),z===null?w=V:z.sibling=V,z=V,D=Q}if(B.done)return a(d,D),ne&&Ia(d,y),w;if(D===null){for(;!B.done;y++,B=p.next())B=g(d,B.value,v),B!==null&&(i=o(B,i,y),z===null?w=B:z.sibling=B,z=B);return ne&&Ia(d,y),w}for(D=n(d,D);!B.done;y++,B=p.next())B=L(D,d,y,B.value,v),B!==null&&(e&&B.alternate!==null&&D.delete(B.key===null?y:B.key),i=o(B,i,y),z===null?w=B:z.sibling=B,z=B);return e&&D.forEach(function(rt){return t(d,rt)}),ne&&Ia(d,y),w}function E(d,i,p,v){if(typeof p==="object"&&p!==null&&p.type===Qa&&p.key===null&&(p=p.props.children),typeof p==="object"&&p!==null){switch(p.$$typeof){case ho:e:{for(var w=p.key,z=i;z!==null;){if(z.key===w){if(w=p.type,w===Qa){if(z.tag===7){a(d,z.sibling),i=r(z,p.props.children),i.return=d,d=i;break e}}else if(z.elementType===w||typeof w==="object"&&w!==null&&w.$$typeof===Vt&&hd(w)===z.type){a(d,z.sibling),i=r(z,p.props),i.ref=Un(d,z,p),i.return=d,d=i;break e}a(d,z);break}else t(d,z);z=z.sibling}p.type===Qa?(i=Ma(p.props.children,d.mode,v,p.key),i.return=d,d=i):(v=Uo(p.type,p.key,p.props,null,d.mode,v),v.ref=Un(d,i,p),v.return=d,d=v)}return s(d);case Wn:e:{for(z=p.key;i!==null;){if(i.key===z)if(i.tag===4&&i.stateNode.containerInfo===p.containerInfo&&i.stateNode.implementation===p.implementation){a(d,i.sibling),i=r(i,p.children||[]),i.return=d,d=i;break e}else{a(d,i);break}else t(d,i);i=i.sibling}i=wl(p,d.mode,v),i.return=d,d=i}return s(d);case Vt:return z=p._init,E(d,i,z(p._payload),v)}if(Gn(p))return x(d,i,p,v);if(En(p))return C(d,i,p,v);Po(d,p)}return typeof p==="string"&&p!==""||typeof p==="number"?(p=""+p,i!==null&&i.tag===6?(a(d,i.sibling),i=r(i,p),i.return=d,d=i):(a(d,i),i=vl(p,d.mode,v),i.return=d,d=i),s(d)):a(d,i)}return E}function Ou(){_u=rn=ts=null}function Nu(e){var t=es.current;ae(es),e._currentValue=t}function Jl(e,t,a){for(;e!==null;){var n=e.alternate;if((e.childLanes&t)!==t?(e.childLanes|=t,n!==null&&(n.childLanes|=t)):n!==null&&(n.childLanes&t)!==t&&(n.childLanes|=t),e===a)break;e=e.return}}function cn(e,t){ts=e,_u=rn=null,e=e.dependencies,e!==null&&e.firstContext!==null&&((e.lanes&t)!==0&&(Ue=!0),e.firstContext=null)}function at(e){var t=e._currentValue;if(_u!==e)if(e={context:e,memoizedValue:t,next:null},rn===null){if(ts===null)throw Error(k(308));rn=e,ts.dependencies={lanes:0,firstContext:e}}else rn=rn.next=e;return t}function Uu(e){Sa===null?Sa=[e]:Sa.push(e)}function Of(e,t,a,n){var r=t.interleaved;return r===null?(a.next=a,Uu(t)):(a.next=r.next,r.next=a),t.interleaved=a,Nt(e,n)}function Nt(e,t){e.lanes|=t;var a=e.alternate;a!==null&&(a.lanes|=t),a=e;for(e=e.return;e!==null;)e.childLanes|=t,a=e.alternate,a!==null&&(a.childLanes|=t),a=e,e=e.return;return a.tag===3?a.stateNode:null}function qu(e){e.updateQueue={baseState:e.memoizedState,firstBaseUpdate:null,lastBaseUpdate:null,shared:{pending:null,interleaved:null,lanes:0},effects:null}}function Nf(e,t){e=e.updateQueue,t.updateQueue===e&&(t.updateQueue={baseState:e.baseState,firstBaseUpdate:e.firstBaseUpdate,lastBaseUpdate:e.lastBaseUpdate,shared:e.shared,effects:e.effects})}function _t(e,t){return{eventTime:e,lane:t,tag:0,payload:null,callback:null,next:null}}function ea(e,t,a){var n=e.updateQueue;if(n===null)return null;if(n=n.shared,(H&2)!==0){var r=n.pending;return r===null?t.next=t:(t.next=r.next,r.next=t),n.pending=t,Nt(e,a)}return r=n.interleaved,r===null?(t.next=t,Uu(n)):(t.next=r.next,r.next=t),n.interleaved=t,Nt(e,a)}function Do(e,t,a){if(t=t.updateQueue,t!==null&&(t=t.shared,(a&4194240)!==0)){var n=t.lanes;n&=e.pendingLanes,a|=n,t.lanes=a,Cu(e,a)}}function gd(e,t){var a=e.updateQueue,n=e.alternate;if(n!==null&&(n=n.updateQueue,a===n)){var r=null,o=null;if(a=a.firstBaseUpdate,a!==null){do{var s={eventTime:a.eventTime,lane:a.lane,tag:a.tag,payload:a.payload,callback:a.callback,next:null};o===null?r=o=s:o=o.next=s,a=a.next}while(a!==null);o===null?r=o=t:o=o.next=t}else r=o=t;a={baseState:n.baseState,firstBaseUpdate:r,lastBaseUpdate:o,shared:n.shared,effects:n.effects},e.updateQueue=a;return}e=a.lastBaseUpdate,e===null?a.firstBaseUpdate=t:e.next=t,a.lastBaseUpdate=t}function as(e,t,a,n){var r=e.updateQueue;Gt=!1;var o=r.firstBaseUpdate,s=r.lastBaseUpdate,l=r.shared.pending;if(l!==null){r.shared.pending=null;var u=l,c=u.next;u.next=null,s===null?o=c:s.next=c,s=u;var m=e.alternate;m!==null&&(m=m.updateQueue,l=m.lastBaseUpdate,l!==s&&(l===null?m.firstBaseUpdate=c:l.next=c,m.lastBaseUpdate=u))}if(o!==null){var g=r.baseState;s=0,m=c=u=null,l=o;do{var h=l.lane,L=l.eventTime;if((n&h)===h){m!==null&&(m=m.next={eventTime:L,lane:0,tag:l.tag,payload:l.payload,callback:l.callback,next:null});e:{var x=e,C=l;switch(h=t,L=a,C.tag){case 1:if(x=C.payload,typeof x==="function"){g=x.call(L,g,h);break e}g=x;break e;case 3:x.flags=x.flags&-65537|128;case 0:if(x=C.payload,h=typeof x==="function"?x.call(L,g,h):x,h===null||h===void 0)break e;g=le({},g,h);break e;case 2:Gt=!0}}l.callback!==null&&l.lane!==0&&(e.flags|=64,h=r.effects,h===null?r.effects=[l]:h.push(l))}else L={eventTime:L,lane:h,tag:l.tag,payload:l.payload,callback:l.callback,next:null},m===null?(c=m=L,u=g):m=m.next=L,s|=h;if(l=l.next,l===null)if(l=r.shared.pending,l===null)break;else h=l,l=h.next,h.next=null,r.lastBaseUpdate=h,r.shared.pending=null}while(1);if(m===null&&(u=g),r.baseState=u,r.firstBaseUpdate=c,r.lastBaseUpdate=m,t=r.shared.interleaved,t!==null){r=t;do s|=r.lane,r=r.next;while(r!==t)}else o===null&&(r.shared.lanes=0);Fa|=s,e.lanes=s,e.memoizedState=g}}function xd(e,t,a){if(e=t.effects,t.effects=null,e!==null)for(t=0;t<e.length;t++){var n=e[t],r=n.callback;if(r!==null){if(n.callback=null,n=a,typeof r!=="function")throw Error(k(191,r));r.call(n)}}}function Pa(e){if(e===Pr)throw Error(k(174));return e}function Hu(e,t){switch(Y(yr,t),Y(Lr,e),Y(At,Pr),e=t.nodeType,e){case 9:case 11:t=(t=t.documentElement)?t.namespaceURI:Rl(null,"");break;default:e=e===8?t.parentNode:t,t=e.namespaceURI||null,e=e.tagName,t=Rl(t,e)}ae(At),Y(At,t)}function Ln(){ae(At),ae(Lr),ae(yr)}function Uf(e){Pa(yr.current);var t=Pa(At.current),a=Rl(t,e.type);t!==a&&(Y(Lr,e),Y(At,a))}function Wu(e){Lr.current===e&&(ae(At),ae(Lr))}function ns(e){for(var t=e;t!==null;){if(t.tag===13){var a=t.memoizedState;if(a!==null&&(a=a.dehydrated,a===null||a.data==="$?"||a.data==="$!"))return t}else if(t.tag===19&&t.memoizedProps.revealOrder!==void 0){if((t.flags&128)!==0)return t}else if(t.child!==null){t.child.return=t,t=t.child;continue}if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return null;t=t.return}t.sibling.return=t.return,t=t.sibling}return null}function Vu(){for(var e=0;e<ml.length;e++)ml[e]._workInProgressVersionPrimary=null;ml.length=0}function Te(){throw Error(k(321))}function Gu(e,t){if(t===null)return!1;for(var a=0;a<t.length&&a<e.length;a++)if(!gt(e[a],t[a]))return!1;return!0}function ju(e,t,a,n,r,o){if(Ra=o,se=t,t.memoizedState=null,t.updateQueue=null,t.lanes=0,Bo.current=e===null||e.memoizedState===null?o0:s0,e=a(n,r),rr){o=0;do{if(rr=!1,vr=0,25<=o)throw Error(k(301));o+=1,we=xe=null,t.updateQueue=null,Bo.current=l0,e=a(n,r)}while(rr)}if(Bo.current=os,t=xe!==null&&xe.next!==null,Ra=0,we=xe=se=null,rs=!1,t)throw Error(k(300));return e}function Ku(){var e=vr!==0;return vr=0,e}function Pt(){var e={memoizedState:null,baseState:null,baseQueue:null,queue:null,next:null};return we===null?se.memoizedState=we=e:we=we.next=e,we}function nt(){if(xe===null){var e=se.alternate;e=e!==null?e.memoizedState:null}else e=xe.next;var t=we===null?se.memoizedState:we.next;if(t!==null)we=t,xe=e;else{if(e===null)throw Error(k(310));xe=e,e={memoizedState:xe.memoizedState,baseState:xe.baseState,baseQueue:xe.baseQueue,queue:xe.queue,next:null},we===null?se.memoizedState=we=e:we=we.next=e}return we}function wr(e,t){return typeof t==="function"?t(e):t}function gl(e){var t=nt(),a=t.queue;if(a===null)throw Error(k(311));a.lastRenderedReducer=e;var n=xe,r=n.baseQueue,o=a.pending;if(o!==null){if(r!==null){var s=r.next;r.next=o.next,o.next=s}n.baseQueue=r=o,a.pending=null}if(r!==null){o=r.next,n=n.baseState;var l=s=null,u=null,c=o;do{var m=c.lane;if((Ra&m)===m)u!==null&&(u=u.next={lane:0,action:c.action,hasEagerState:c.hasEagerState,eagerState:c.eagerState,next:null}),n=c.hasEagerState?c.eagerState:e(n,c.action);else{var g={lane:m,action:c.action,hasEagerState:c.hasEagerState,eagerState:c.eagerState,next:null};u===null?(l=u=g,s=n):u=u.next=g,se.lanes|=m,Fa|=m}c=c.next}while(c!==null&&c!==o);u===null?s=n:u.next=l,gt(n,t.memoizedState)||(Ue=!0),t.memoizedState=n,t.baseState=s,t.baseQueue=u,a.lastRenderedState=n}if(e=a.interleaved,e!==null){r=e;do o=r.lane,se.lanes|=o,Fa|=o,r=r.next;while(r!==e)}else r===null&&(a.lanes=0);return[t.memoizedState,a.dispatch]}function xl(e){var t=nt(),a=t.queue;if(a===null)throw Error(k(311));a.lastRenderedReducer=e;var{dispatch:n,pending:r}=a,o=t.memoizedState;if(r!==null){a.pending=null;var s=r=r.next;do o=e(o,s.action),s=s.next;while(s!==r);gt(o,t.memoizedState)||(Ue=!0),t.memoizedState=o,t.baseQueue===null&&(t.baseState=o),a.lastRenderedState=o}return[o,n]}function qf(){}function Hf(e,t){var a=se,n=nt(),r=t(),o=!gt(n.memoizedState,r);if(o&&(n.memoizedState=r,Ue=!0),n=n.queue,Xu(Gf.bind(null,a,n,e),[e]),n.getSnapshot!==t||o||we!==null&&we.memoizedState.tag&1){if(a.flags|=2048,Ir(9,Vf.bind(null,a,n,r,t),void 0,null),Ie===null)throw Error(k(349));(Ra&30)!==0||Wf(a,t,r)}return r}function Wf(e,t,a){e.flags|=16384,e={getSnapshot:t,value:a},t=se.updateQueue,t===null?(t={lastEffect:null,stores:null},se.updateQueue=t,t.stores=[e]):(a=t.stores,a===null?t.stores=[e]:a.push(e))}function Vf(e,t,a,n){t.value=a,t.getSnapshot=n,jf(t)&&Kf(e)}function Gf(e,t,a){return a(function(){jf(t)&&Kf(e)})}function jf(e){var t=e.getSnapshot;e=e.value;try{var a=t();return!gt(e,a)}catch(n){return!0}}function Kf(e){var t=Nt(e,1);t!==null&&ht(t,e,1,-1)}function Ld(e){var t=Pt();return typeof e==="function"&&(e=e()),t.memoizedState=t.baseState=e,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:wr,lastRenderedState:e},t.queue=e,e=e.dispatch=r0.bind(null,se,e),[t.memoizedState,e]}function Ir(e,t,a,n){return e={tag:e,create:t,destroy:a,deps:n,next:null},t=se.updateQueue,t===null?(t={lastEffect:null,stores:null},se.updateQueue=t,t.lastEffect=e.next=e):(a=t.lastEffect,a===null?t.lastEffect=e.next=e:(n=a.next,a.next=e,e.next=n,t.lastEffect=e)),e}function Xf(){return nt().memoizedState}function Eo(e,t,a,n){var r=Pt();se.flags|=e,r.memoizedState=Ir(1|t,a,void 0,n===void 0?null:n)}function gs(e,t,a,n){var r=nt();n=n===void 0?null:n;var o=void 0;if(xe!==null){var s=xe.memoizedState;if(o=s.destroy,n!==null&&Gu(n,s.deps)){r.memoizedState=Ir(t,a,o,n);return}}se.flags|=e,r.memoizedState=Ir(1|t,a,o,n)}function yd(e,t){return Eo(8390656,8,e,t)}function Xu(e,t){return gs(2048,8,e,t)}function $f(e,t){return gs(4,2,e,t)}function Zf(e,t){return gs(4,4,e,t)}function Qf(e,t){if(typeof t==="function")return e=e(),t(e),function(){t(null)};if(t!==null&&t!==void 0)return e=e(),t.current=e,function(){t.current=null}}function Yf(e,t,a){return a=a!==null&&a!==void 0?a.concat([e]):null,gs(4,4,Qf.bind(null,t,e),a)}function $u(){}function Jf(e,t){var a=nt();t=t===void 0?null:t;var n=a.memoizedState;if(n!==null&&t!==null&&Gu(t,n[1]))return n[0];return a.memoizedState=[e,t],e}function ec(e,t){var a=nt();t=t===void 0?null:t;var n=a.memoizedState;if(n!==null&&t!==null&&Gu(t,n[1]))return n[0];return e=e(),a.memoizedState=[e,t],e}function tc(e,t,a){if((Ra&21)===0)return e.baseState&&(e.baseState=!1,Ue=!0),e.memoizedState=a;return gt(a,t)||(a=of(),se.lanes|=a,Fa|=a,e.baseState=!0),t}function a0(e,t){var a=K;K=a!==0&&4>a?a:4,e(!0);var n=hl.transition;hl.transition={};try{e(!1),t()}finally{K=a,hl.transition=n}}function ac(){return nt().memoizedState}function n0(e,t,a){var n=aa(e);if(a={lane:n,action:a,hasEagerState:!1,eagerState:null,next:null},nc(e))rc(t,a);else if(a=Of(e,t,a,n),a!==null){var r=_e();ht(a,e,n,r),oc(a,t,n)}}function r0(e,t,a){var n=aa(e),r={lane:n,action:a,hasEagerState:!1,eagerState:null,next:null};if(nc(e))rc(t,r);else{var o=e.alternate;if(e.lanes===0&&(o===null||o.lanes===0)&&(o=t.lastRenderedReducer,o!==null))try{var s=t.lastRenderedState,l=o(s,a);if(r.hasEagerState=!0,r.eagerState=l,gt(l,s)){var u=t.interleaved;u===null?(r.next=r,Uu(t)):(r.next=u.next,u.next=r),t.interleaved=r;return}}catch(c){}finally{}a=Of(e,t,r,n),a!==null&&(r=_e(),ht(a,e,n,r),oc(a,t,n))}}function nc(e){var t=e.alternate;return e===se||t!==null&&t===se}function rc(e,t){rr=rs=!0;var a=e.pending;a===null?t.next=t:(t.next=a.next,a.next=t),e.pending=t}function oc(e,t,a){if((a&4194240)!==0){var n=t.lanes;n&=e.pendingLanes,a|=n,t.lanes=a,Cu(e,a)}}function ft(e,t){if(e&&e.defaultProps){t=le({},t),e=e.defaultProps;for(var a in e)t[a]===void 0&&(t[a]=e[a]);return t}return t}function eu(e,t,a,n){t=e.memoizedState,a=a(n,t),a=a===null||a===void 0?t:le({},t,a),e.memoizedState=a,e.lanes===0&&(e.updateQueue.baseState=a)}function vd(e,t,a,n,r,o,s){return e=e.stateNode,typeof e.shouldComponentUpdate==="function"?e.shouldComponentUpdate(n,o,s):t.prototype&&t.prototype.isPureReactComponent?!hr(a,n)||!hr(r,o):!0}function sc(e,t,a){var n=!1,r=oa,o=t.contextType;return typeof o==="object"&&o!==null?o=at(o):(r=He(t)?Aa:ze.current,n=t.contextTypes,o=(n=n!==null&&n!==void 0)?hn(e,r):oa),t=new t(a,o),e.memoizedState=t.state!==null&&t.state!==void 0?t.state:null,t.updater=xs,e.stateNode=t,t._reactInternals=e,n&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=r,e.__reactInternalMemoizedMaskedChildContext=o),t}function wd(e,t,a,n){e=t.state,typeof t.componentWillReceiveProps==="function"&&t.componentWillReceiveProps(a,n),typeof t.UNSAFE_componentWillReceiveProps==="function"&&t.UNSAFE_componentWillReceiveProps(a,n),t.state!==e&&xs.enqueueReplaceState(t,t.state,null)}function tu(e,t,a,n){var r=e.stateNode;r.props=a,r.state=e.memoizedState,r.refs={},qu(e);var o=t.contextType;typeof o==="object"&&o!==null?r.context=at(o):(o=He(t)?Aa:ze.current,r.context=hn(e,o)),r.state=e.memoizedState,o=t.getDerivedStateFromProps,typeof o==="function"&&(eu(e,t,o,a),r.state=e.memoizedState),typeof t.getDerivedStateFromProps==="function"||typeof r.getSnapshotBeforeUpdate==="function"||typeof r.UNSAFE_componentWillMount!=="function"&&typeof r.componentWillMount!=="function"||(t=r.state,typeof r.componentWillMount==="function"&&r.componentWillMount(),typeof r.UNSAFE_componentWillMount==="function"&&r.UNSAFE_componentWillMount(),t!==r.state&&xs.enqueueReplaceState(r,r.state,null),as(e,a,r,n),r.state=e.memoizedState),typeof r.componentDidMount==="function"&&(e.flags|=4194308)}function yn(e,t){try{var a="",n=t;do a+=Dm(n),n=n.return;while(n);var r=a}catch(o){r=`
Error generating stack: `+o.message+`
`+o.stack}return{value:e,source:t,stack:r,digest:null}}function Ll(e,t,a){return{value:e,source:null,stack:a!=null?a:null,digest:t!=null?t:null}}function au(e,t){try{console.error(t.value)}catch(a){setTimeout(function(){throw a})}}function lc(e,t,a){a=_t(-1,a),a.tag=3,a.payload={element:null};var n=t.value;return a.callback=function(){ls||(ls=!0,cu=n),au(e,t)},a}function uc(e,t,a){a=_t(-1,a),a.tag=3;var n=e.type.getDerivedStateFromError;if(typeof n==="function"){var r=t.value;a.payload=function(){return n(r)},a.callback=function(){au(e,t)}}var o=e.stateNode;return o!==null&&typeof o.componentDidCatch==="function"&&(a.callback=function(){au(e,t),typeof n!=="function"&&(ta===null?ta=new Set([this]):ta.add(this));var s=t.stack;this.componentDidCatch(t.value,{componentStack:s!==null?s:""})}),a}function Id(e,t,a){var n=e.pingCache;if(n===null){n=e.pingCache=new u0;var r=new Set;n.set(t,r)}else r=n.get(t),r===void 0&&(r=new Set,n.set(t,r));r.has(a)||(r.add(a),e=k0.bind(null,e,t,a),t.then(e,e))}function kd(e){do{var t;if(t=e.tag===13)t=e.memoizedState,t=t!==null?t.dehydrated!==null?!0:!1:!0;if(t)return e;e=e.return}while(e!==null);return null}function Cd(e,t,a,n,r){if((e.mode&1)===0)return e===t?e.flags|=65536:(e.flags|=128,a.flags|=131072,a.flags&=-52805,a.tag===1&&(a.alternate===null?a.tag=17:(t=_t(-1,1),t.tag=2,ea(a,t,1))),a.lanes|=1),e;return e.flags|=65536,e.lanes=r,e}function Ee(e,t,a,n){t.child=e===null?_f(t,null,a,n):xn(t,e.child,a,n)}function Sd(e,t,a,n,r){a=a.render;var o=t.ref;if(cn(t,r),n=ju(e,t,a,n,o,r),a=Ku(),e!==null&&!Ue)return t.updateQueue=e.updateQueue,t.flags&=-2053,e.lanes&=~r,Ut(e,t,r);return ne&&a&&Du(t),t.flags|=1,Ee(e,t,n,r),t.child}function Pd(e,t,a,n,r){if(e===null){var o=a.type;if(typeof o==="function"&&!ai(o)&&o.defaultProps===void 0&&a.compare===null&&a.defaultProps===void 0)return t.tag=15,t.type=o,ic(e,t,o,n,r);return e=Uo(a.type,null,n,t,t.mode,r),e.ref=t.ref,e.return=t,t.child=e}if(o=e.child,(e.lanes&r)===0){var s=o.memoizedProps;if(a=a.compare,a=a!==null?a:hr,a(s,n)&&e.ref===t.ref)return Ut(e,t,r)}return t.flags|=1,e=na(o,n),e.ref=t.ref,e.return=t,t.child=e}function ic(e,t,a,n,r){if(e!==null){var o=e.memoizedProps;if(hr(o,n)&&e.ref===t.ref)if(Ue=!1,t.pendingProps=n=o,(e.lanes&r)!==0)(e.flags&131072)!==0&&(Ue=!0);else return t.lanes=e.lanes,Ut(e,t,r)}return nu(e,t,a,n,r)}function dc(e,t,a){var n=t.pendingProps,r=n.children,o=e!==null?e.memoizedState:null;if(n.mode==="hidden")if((t.mode&1)===0)t.memoizedState={baseLanes:0,cachePool:null,transitions:null},Y(sn,Ge),Ge|=a;else{if((a&1073741824)===0)return e=o!==null?o.baseLanes|a:a,t.lanes=t.childLanes=1073741824,t.memoizedState={baseLanes:e,cachePool:null,transitions:null},t.updateQueue=null,Y(sn,Ge),Ge|=e,null;t.memoizedState={baseLanes:0,cachePool:null,transitions:null},n=o!==null?o.baseLanes:a,Y(sn,Ge),Ge|=n}else o!==null?(n=o.baseLanes|a,t.memoizedState=null):n=a,Y(sn,Ge),Ge|=n;return Ee(e,t,r,a),t.child}function fc(e,t){var a=t.ref;if(e===null&&a!==null||e!==null&&e.ref!==a)t.flags|=512,t.flags|=2097152}function nu(e,t,a,n,r){var o=He(a)?Aa:ze.current;if(o=hn(t,o),cn(t,r),a=ju(e,t,a,n,o,r),n=Ku(),e!==null&&!Ue)return t.updateQueue=e.updateQueue,t.flags&=-2053,e.lanes&=~r,Ut(e,t,r);return ne&&n&&Du(t),t.flags|=1,Ee(e,t,a,r),t.child}function bd(e,t,a,n,r){if(He(a)){var o=!0;Qo(t)}else o=!1;if(cn(t,r),t.stateNode===null)_o(e,t),sc(t,a,n),tu(t,a,n,r),n=!0;else if(e===null){var{stateNode:s,memoizedProps:l}=t;s.props=l;var u=s.context,c=a.contextType;typeof c==="object"&&c!==null?c=at(c):(c=He(a)?Aa:ze.current,c=hn(t,c));var m=a.getDerivedStateFromProps,g=typeof m==="function"||typeof s.getSnapshotBeforeUpdate==="function";g||typeof s.UNSAFE_componentWillReceiveProps!=="function"&&typeof s.componentWillReceiveProps!=="function"||(l!==n||u!==c)&&wd(t,s,n,c),Gt=!1;var h=t.memoizedState;s.state=h,as(t,n,s,r),u=t.memoizedState,l!==n||h!==u||qe.current||Gt?(typeof m==="function"&&(eu(t,a,m,n),u=t.memoizedState),(l=Gt||vd(t,a,l,n,h,u,c))?(g||typeof s.UNSAFE_componentWillMount!=="function"&&typeof s.componentWillMount!=="function"||(typeof s.componentWillMount==="function"&&s.componentWillMount(),typeof s.UNSAFE_componentWillMount==="function"&&s.UNSAFE_componentWillMount()),typeof s.componentDidMount==="function"&&(t.flags|=4194308)):(typeof s.componentDidMount==="function"&&(t.flags|=4194308),t.memoizedProps=n,t.memoizedState=u),s.props=n,s.state=u,s.context=c,n=l):(typeof s.componentDidMount==="function"&&(t.flags|=4194308),n=!1)}else{s=t.stateNode,Nf(e,t),l=t.memoizedProps,c=t.type===t.elementType?l:ft(t.type,l),s.props=c,g=t.pendingProps,h=s.context,u=a.contextType,typeof u==="object"&&u!==null?u=at(u):(u=He(a)?Aa:ze.current,u=hn(t,u));var L=a.getDerivedStateFromProps;(m=typeof L==="function"||typeof s.getSnapshotBeforeUpdate==="function")||typeof s.UNSAFE_componentWillReceiveProps!=="function"&&typeof s.componentWillReceiveProps!=="function"||(l!==g||h!==u)&&wd(t,s,n,u),Gt=!1,h=t.memoizedState,s.state=h,as(t,n,s,r);var x=t.memoizedState;l!==g||h!==x||qe.current||Gt?(typeof L==="function"&&(eu(t,a,L,n),x=t.memoizedState),(c=Gt||vd(t,a,c,n,h,x,u)||!1)?(m||typeof s.UNSAFE_componentWillUpdate!=="function"&&typeof s.componentWillUpdate!=="function"||(typeof s.componentWillUpdate==="function"&&s.componentWillUpdate(n,x,u),typeof s.UNSAFE_componentWillUpdate==="function"&&s.UNSAFE_componentWillUpdate(n,x,u)),typeof s.componentDidUpdate==="function"&&(t.flags|=4),typeof s.getSnapshotBeforeUpdate==="function"&&(t.flags|=1024)):(typeof s.componentDidUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(t.flags|=4),typeof s.getSnapshotBeforeUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(t.flags|=1024),t.memoizedProps=n,t.memoizedState=x),s.props=n,s.state=x,s.context=u,n=c):(typeof s.componentDidUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(t.flags|=4),typeof s.getSnapshotBeforeUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(t.flags|=1024),n=!1)}return ru(e,t,a,n,o,r)}function ru(e,t,a,n,r,o){fc(e,t);var s=(t.flags&128)!==0;if(!n&&!s)return r&&cd(t,a,!1),Ut(e,t,o);n=t.stateNode,i0.current=t;var l=s&&typeof a.getDerivedStateFromError!=="function"?null:n.render();return t.flags|=1,e!==null&&s?(t.child=xn(t,e.child,null,o),t.child=xn(t,null,l,o)):Ee(e,t,l,o),t.memoizedState=n.state,r&&cd(t,a,!0),t.child}function cc(e){var t=e.stateNode;t.pendingContext?fd(e,t.pendingContext,t.pendingContext!==t.context):t.context&&fd(e,t.context,!1),Hu(e,t.containerInfo)}function Md(e,t,a,n,r){return gn(),Eu(r),t.flags|=256,Ee(e,t,a,n),t.child}function su(e){return{baseLanes:e,cachePool:null,transitions:null}}function pc(e,t,a){var n=t.pendingProps,r=oe.current,o=!1,s=(t.flags&128)!==0,l;if((l=s)||(l=e!==null&&e.memoizedState===null?!1:(r&2)!==0),l)o=!0,t.flags&=-129;else if(e===null||e.memoizedState!==null)r|=1;if(Y(oe,r&1),e===null){if(Yl(t),e=t.memoizedState,e!==null&&(e=e.dehydrated,e!==null))return(t.mode&1)===0?t.lanes=1:e.data==="$!"?t.lanes=8:t.lanes=1073741824,null;return s=n.children,e=n.fallback,o?(n=t.mode,o=t.child,s={mode:"hidden",children:s},(n&1)===0&&o!==null?(o.childLanes=0,o.pendingProps=s):o=ws(s,n,0,null),e=Ma(e,n,a,null),o.return=t,e.return=t,o.sibling=e,t.child=o,t.child.memoizedState=su(a),t.memoizedState=ou,e):Zu(t,s)}if(r=e.memoizedState,r!==null&&(l=r.dehydrated,l!==null))return d0(e,t,s,n,l,r,a);if(o){o=n.fallback,s=t.mode,r=e.child,l=r.sibling;var u={mode:"hidden",children:n.children};return(s&1)===0&&t.child!==r?(n=t.child,n.childLanes=0,n.pendingProps=u,t.deletions=null):(n=na(r,u),n.subtreeFlags=r.subtreeFlags&14680064),l!==null?o=na(l,o):(o=Ma(o,s,a,null),o.flags|=2),o.return=t,n.return=t,n.sibling=o,t.child=n,n=o,o=t.child,s=e.child.memoizedState,s=s===null?su(a):{baseLanes:s.baseLanes|a,cachePool:null,transitions:s.transitions},o.memoizedState=s,o.childLanes=e.childLanes&~a,t.memoizedState=ou,n}return o=e.child,e=o.sibling,n=na(o,{mode:"visible",children:n.children}),(t.mode&1)===0&&(n.lanes=a),n.return=t,n.sibling=null,e!==null&&(a=t.deletions,a===null?(t.deletions=[e],t.flags|=16):a.push(e)),t.child=n,t.memoizedState=null,n}function Zu(e,t){return t=ws({mode:"visible",children:t},e.mode,0,null),t.return=e,e.child=t}function bo(e,t,a,n){return n!==null&&Eu(n),xn(t,e.child,null,a),e=Zu(t,t.pendingProps.children),e.flags|=2,t.memoizedState=null,e}function d0(e,t,a,n,r,o,s){if(a){if(t.flags&256)return t.flags&=-257,n=Ll(Error(k(422))),bo(e,t,s,n);if(t.memoizedState!==null)return t.child=e.child,t.flags|=128,null;return o=n.fallback,r=t.mode,n=ws({mode:"visible",children:n.children},r,0,null),o=Ma(o,r,s,null),o.flags|=2,n.return=t,o.return=t,n.sibling=o,t.child=n,(t.mode&1)!==0&&xn(t,e.child,null,s),t.child.memoizedState=su(s),t.memoizedState=ou,o}if((t.mode&1)===0)return bo(e,t,s,null);if(r.data==="$!"){if(n=r.nextSibling&&r.nextSibling.dataset,n)var l=n.dgst;return n=l,o=Error(k(419)),n=Ll(o,n,void 0),bo(e,t,s,n)}if(l=(s&e.childLanes)!==0,Ue||l){if(n=Ie,n!==null){switch(s&-s){case 4:r=2;break;case 16:r=8;break;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:r=32;break;case 536870912:r=268435456;break;default:r=0}r=(r&(n.suspendedLanes|s))!==0?0:r,r!==0&&r!==o.retryLane&&(o.retryLane=r,Nt(e,r),ht(n,e,r,-1))}return ti(),n=Ll(Error(k(421))),bo(e,t,s,n)}if(r.data==="$?")return t.flags|=128,t.child=e.child,t=C0.bind(null,e),r._reactRetry=t,null;return e=o.treeContext,je=Jt(r.nextSibling),Ke=t,ne=!0,pt=null,e!==null&&(Ye[Je++]=Bt,Ye[Je++]=Et,Ye[Je++]=Ta,Bt=e.id,Et=e.overflow,Ta=t),t=Zu(t,n.children),t.flags|=4096,t}function Ad(e,t,a){e.lanes|=t;var n=e.alternate;n!==null&&(n.lanes|=t),Jl(e.return,t,a)}function yl(e,t,a,n,r){var o=e.memoizedState;o===null?e.memoizedState={isBackwards:t,rendering:null,renderingStartTime:0,last:n,tail:a,tailMode:r}:(o.isBackwards=t,o.rendering=null,o.renderingStartTime=0,o.last=n,o.tail=a,o.tailMode=r)}function mc(e,t,a){var n=t.pendingProps,r=n.revealOrder,o=n.tail;if(Ee(e,t,n.children,a),n=oe.current,(n&2)!==0)n=n&1|2,t.flags|=128;else{if(e!==null&&(e.flags&128)!==0)e:for(e=t.child;e!==null;){if(e.tag===13)e.memoizedState!==null&&Ad(e,a,t);else if(e.tag===19)Ad(e,a,t);else if(e.child!==null){e.child.return=e,e=e.child;continue}if(e===t)break e;for(;e.sibling===null;){if(e.return===null||e.return===t)break e;e=e.return}e.sibling.return=e.return,e=e.sibling}n&=1}if(Y(oe,n),(t.mode&1)===0)t.memoizedState=null;else switch(r){case"forwards":a=t.child;for(r=null;a!==null;)e=a.alternate,e!==null&&ns(e)===null&&(r=a),a=a.sibling;a=r,a===null?(r=t.child,t.child=null):(r=a.sibling,a.sibling=null),yl(t,!1,r,a,o);break;case"backwards":a=null,r=t.child;for(t.child=null;r!==null;){if(e=r.alternate,e!==null&&ns(e)===null){t.child=r;break}e=r.sibling,r.sibling=a,a=r,r=e}yl(t,!0,a,null,o);break;case"together":yl(t,!1,null,null,void 0);break;default:t.memoizedState=null}return t.child}function _o(e,t){(t.mode&1)===0&&e!==null&&(e.alternate=null,t.alternate=null,t.flags|=2)}function Ut(e,t,a){if(e!==null&&(t.dependencies=e.dependencies),Fa|=t.lanes,(a&t.childLanes)===0)return null;if(e!==null&&t.child!==e.child)throw Error(k(153));if(t.child!==null){e=t.child,a=na(e,e.pendingProps),t.child=a;for(a.return=t;e.sibling!==null;)e=e.sibling,a=a.sibling=na(e,e.pendingProps),a.return=t;a.sibling=null}return t.child}function f0(e,t,a){switch(t.tag){case 3:cc(t),gn();break;case 5:Uf(t);break;case 1:He(t.type)&&Qo(t);break;case 4:Hu(t,t.stateNode.containerInfo);break;case 10:var n=t.type._context,r=t.memoizedProps.value;Y(es,n._currentValue),n._currentValue=r;break;case 13:if(n=t.memoizedState,n!==null){if(n.dehydrated!==null)return Y(oe,oe.current&1),t.flags|=128,null;if((a&t.child.childLanes)!==0)return pc(e,t,a);return Y(oe,oe.current&1),e=Ut(e,t,a),e!==null?e.sibling:null}Y(oe,oe.current&1);break;case 19:if(n=(a&t.childLanes)!==0,(e.flags&128)!==0){if(n)return mc(e,t,a);t.flags|=128}if(r=t.memoizedState,r!==null&&(r.rendering=null,r.tail=null,r.lastEffect=null),Y(oe,oe.current),n)break;else return null;case 22:case 23:return t.lanes=0,dc(e,t,a)}return Ut(e,t,a)}function qn(e,t){if(!ne)switch(e.tailMode){case"hidden":t=e.tail;for(var a=null;t!==null;)t.alternate!==null&&(a=t),t=t.sibling;a===null?e.tail=null:a.sibling=null;break;case"collapsed":a=e.tail;for(var n=null;a!==null;)a.alternate!==null&&(n=a),a=a.sibling;n===null?t||e.tail===null?e.tail=null:e.tail.sibling=null:n.sibling=null}}function Re(e){var t=e.alternate!==null&&e.alternate.child===e.child,a=0,n=0;if(t)for(var r=e.child;r!==null;)a|=r.lanes|r.childLanes,n|=r.subtreeFlags&14680064,n|=r.flags&14680064,r.return=e,r=r.sibling;else for(r=e.child;r!==null;)a|=r.lanes|r.childLanes,n|=r.subtreeFlags,n|=r.flags,r.return=e,r=r.sibling;return e.subtreeFlags|=n,e.childLanes=a,t}function c0(e,t,a){var n=t.pendingProps;switch(Bu(t),t.tag){case 2:case 16:case 15:case 0:case 11:case 7:case 8:case 12:case 9:case 14:return Re(t),null;case 1:return He(t.type)&&Zo(),Re(t),null;case 3:if(n=t.stateNode,Ln(),ae(qe),ae(ze),Vu(),n.pendingContext&&(n.context=n.pendingContext,n.pendingContext=null),e===null||e.child===null)So(t)?t.flags|=4:e===null||e.memoizedState.isDehydrated&&(t.flags&256)===0||(t.flags|=1024,pt!==null&&(hu(pt),pt=null));return lu(e,t),Re(t),null;case 5:Wu(t);var r=Pa(yr.current);if(a=t.type,e!==null&&t.stateNode!=null)gc(e,t,a,n,r),e.ref!==t.ref&&(t.flags|=512,t.flags|=2097152);else{if(!n){if(t.stateNode===null)throw Error(k(166));return Re(t),null}if(e=Pa(At.current),So(t)){n=t.stateNode,a=t.type;var o=t.memoizedProps;switch(n[bt]=t,n[xr]=o,e=(t.mode&1)!==0,a){case"dialog":te("cancel",n),te("close",n);break;case"iframe":case"object":case"embed":te("load",n);break;case"video":case"audio":for(r=0;r<Qn.length;r++)te(Qn[r],n);break;case"source":te("error",n);break;case"img":case"image":case"link":te("error",n),te("load",n);break;case"details":te("toggle",n);break;case"input":Ni(n,o),te("invalid",n);break;case"select":n._wrapperState={wasMultiple:!!o.multiple},te("invalid",n);break;case"textarea":qi(n,o),te("invalid",n)}Fl(a,o),r=null;for(var s in o)if(o.hasOwnProperty(s)){var l=o[s];s==="children"?typeof l==="string"?n.textContent!==l&&(o.suppressHydrationWarning!==!0&&Co(n.textContent,l,e),r=["children",l]):typeof l==="number"&&n.textContent!==""+l&&(o.suppressHydrationWarning!==!0&&Co(n.textContent,l,e),r=["children",""+l]):ur.hasOwnProperty(s)&&l!=null&&s==="onScroll"&&te("scroll",n)}switch(a){case"input":go(n),Ui(n,o,!0);break;case"textarea":go(n),Hi(n);break;case"select":case"option":break;default:typeof o.onClick==="function"&&(n.onclick=$o)}n=r,t.updateQueue=n,n!==null&&(t.flags|=4)}else{s=r.nodeType===9?r:r.ownerDocument,e==="http://www.w3.org/1999/xhtml"&&(e=Kd(a)),e==="http://www.w3.org/1999/xhtml"?a==="script"?(e=s.createElement("div"),e.innerHTML="<script></script>",e=e.removeChild(e.firstChild)):typeof n.is==="string"?e=s.createElement(a,{is:n.is}):(e=s.createElement(a),a==="select"&&(s=e,n.multiple?s.multiple=!0:n.size&&(s.size=n.size))):e=s.createElementNS(e,a),e[bt]=t,e[xr]=n,hc(e,t,!1,!1),t.stateNode=e;e:{switch(s=zl(a,n),a){case"dialog":te("cancel",e),te("close",e),r=n;break;case"iframe":case"object":case"embed":te("load",e),r=n;break;case"video":case"audio":for(r=0;r<Qn.length;r++)te(Qn[r],e);r=n;break;case"source":te("error",e),r=n;break;case"img":case"image":case"link":te("error",e),te("load",e),r=n;break;case"details":te("toggle",e),r=n;break;case"input":Ni(e,n),r=bl(e,n),te("invalid",e);break;case"option":r=n;break;case"select":e._wrapperState={wasMultiple:!!n.multiple},r=le({},n,{value:void 0}),te("invalid",e);break;case"textarea":qi(e,n),r=Tl(e,n),te("invalid",e);break;default:r=n}Fl(a,r),l=r;for(o in l)if(l.hasOwnProperty(o)){var u=l[o];o==="style"?Zd(e,u):o==="dangerouslySetInnerHTML"?(u=u?u.__html:void 0,u!=null&&Xd(e,u)):o==="children"?typeof u==="string"?(a!=="textarea"||u!=="")&&ir(e,u):typeof u==="number"&&ir(e,""+u):o!=="suppressContentEditableWarning"&&o!=="suppressHydrationWarning"&&o!=="autoFocus"&&(ur.hasOwnProperty(o)?u!=null&&o==="onScroll"&&te("scroll",e):u!=null&&Lu(e,o,u,s))}switch(a){case"input":go(e),Ui(e,n,!1);break;case"textarea":go(e),Hi(e);break;case"option":n.value!=null&&e.setAttribute("value",""+ra(n.value));break;case"select":e.multiple=!!n.multiple,o=n.value,o!=null?ln(e,!!n.multiple,o,!1):n.defaultValue!=null&&ln(e,!!n.multiple,n.defaultValue,!0);break;default:typeof r.onClick==="function"&&(e.onclick=$o)}switch(a){case"button":case"input":case"select":case"textarea":n=!!n.autoFocus;break e;case"img":n=!0;break e;default:n=!1}}n&&(t.flags|=4)}t.ref!==null&&(t.flags|=512,t.flags|=2097152)}return Re(t),null;case 6:if(e&&t.stateNode!=null)xc(e,t,e.memoizedProps,n);else{if(typeof n!=="string"&&t.stateNode===null)throw Error(k(166));if(a=Pa(yr.current),Pa(At.current),So(t)){if(n=t.stateNode,a=t.memoizedProps,n[bt]=t,o=n.nodeValue!==a){if(e=Ke,e!==null)switch(e.tag){case 3:Co(n.nodeValue,a,(e.mode&1)!==0);break;case 5:e.memoizedProps.suppressHydrationWarning!==!0&&Co(n.nodeValue,a,(e.mode&1)!==0)}}o&&(t.flags|=4)}else n=(a.nodeType===9?a:a.ownerDocument).createTextNode(n),n[bt]=t,t.stateNode=n}return Re(t),null;case 13:if(ae(oe),n=t.memoizedState,e===null||e.memoizedState!==null&&e.memoizedState.dehydrated!==null){if(ne&&je!==null&&(t.mode&1)!==0&&(t.flags&128)===0)Bf(),gn(),t.flags|=98560,o=!1;else if(o=So(t),n!==null&&n.dehydrated!==null){if(e===null){if(!o)throw Error(k(318));if(o=t.memoizedState,o=o!==null?o.dehydrated:null,!o)throw Error(k(317));o[bt]=t}else gn(),(t.flags&128)===0&&(t.memoizedState=null),t.flags|=4;Re(t),o=!1}else pt!==null&&(hu(pt),pt=null),o=!0;if(!o)return t.flags&65536?t:null}if((t.flags&128)!==0)return t.lanes=a,t;return n=n!==null,n!==(e!==null&&e.memoizedState!==null)&&n&&(t.child.flags|=8192,(t.mode&1)!==0&&(e===null||(oe.current&1)!==0?Le===0&&(Le=3):ti())),t.updateQueue!==null&&(t.flags|=4),Re(t),null;case 4:return Ln(),lu(e,t),e===null&&Fu(t.stateNode.containerInfo),Re(t),null;case 10:return Nu(t.type._context),Re(t),null;case 17:return He(t.type)&&Zo(),Re(t),null;case 19:if(ae(oe),o=t.memoizedState,o===null)return Re(t),null;if(n=(t.flags&128)!==0,s=o.rendering,s===null)if(n)qn(o,!1);else{if(Le!==0||e!==null&&(e.flags&128)!==0)for(e=t.child;e!==null;){if(s=ns(e),s!==null){t.flags|=128,qn(o,!1),n=s.updateQueue,n!==null&&(t.updateQueue=n,t.flags|=4),t.subtreeFlags=0,n=a;for(a=t.child;a!==null;)o=a,e=n,o.flags&=14680066,s=o.alternate,s===null?(o.childLanes=0,o.lanes=e,o.child=null,o.subtreeFlags=0,o.memoizedProps=null,o.memoizedState=null,o.updateQueue=null,o.dependencies=null,o.stateNode=null):(o.childLanes=s.childLanes,o.lanes=s.lanes,o.child=s.child,o.subtreeFlags=0,o.deletions=null,o.memoizedProps=s.memoizedProps,o.memoizedState=s.memoizedState,o.updateQueue=s.updateQueue,o.type=s.type,e=s.dependencies,o.dependencies=e===null?null:{lanes:e.lanes,firstContext:e.firstContext}),a=a.sibling;return Y(oe,oe.current&1|2),t.child}e=e.sibling}o.tail!==null&&me()>vn&&(t.flags|=128,n=!0,qn(o,!1),t.lanes=4194304)}else{if(!n)if(e=ns(s),e!==null){if(t.flags|=128,n=!0,a=e.updateQueue,a!==null&&(t.updateQueue=a,t.flags|=4),qn(o,!0),o.tail===null&&o.tailMode==="hidden"&&!s.alternate&&!ne)return Re(t),null}else 2*me()-o.renderingStartTime>vn&&a!==1073741824&&(t.flags|=128,n=!0,qn(o,!1),t.lanes=4194304);o.isBackwards?(s.sibling=t.child,t.child=s):(a=o.last,a!==null?a.sibling=s:t.child=s,o.last=s)}if(o.tail!==null)return t=o.tail,o.rendering=t,o.tail=t.sibling,o.renderingStartTime=me(),t.sibling=null,a=oe.current,Y(oe,n?a&1|2:a&1),t;return Re(t),null;case 22:case 23:return ei(),n=t.memoizedState!==null,e!==null&&e.memoizedState!==null!==n&&(t.flags|=8192),n&&(t.mode&1)!==0?(Ge&1073741824)!==0&&(Re(t),t.subtreeFlags&6&&(t.flags|=8192)):Re(t),null;case 24:return null;case 25:return null}throw Error(k(156,t.tag))}function p0(e,t){switch(Bu(t),t.tag){case 1:return He(t.type)&&Zo(),e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 3:return Ln(),ae(qe),ae(ze),Vu(),e=t.flags,(e&65536)!==0&&(e&128)===0?(t.flags=e&-65537|128,t):null;case 5:return Wu(t),null;case 13:if(ae(oe),e=t.memoizedState,e!==null&&e.dehydrated!==null){if(t.alternate===null)throw Error(k(340));gn()}return e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 19:return ae(oe),null;case 4:return Ln(),null;case 10:return Nu(t.type._context),null;case 22:case 23:return ei(),null;case 24:return null;default:return null}}function on(e,t){var a=e.ref;if(a!==null)if(typeof a==="function")try{a(null)}catch(n){de(e,t,n)}else a.current=null}function uu(e,t,a){try{a()}catch(n){de(e,t,n)}}function h0(e,t){if(Gl=jo,e=If(),Ru(e)){if("selectionStart"in e)var a={start:e.selectionStart,end:e.selectionEnd};else e:{a=(a=e.ownerDocument)&&a.defaultView||window;var n=a.getSelection&&a.getSelection();if(n&&n.rangeCount!==0){a=n.anchorNode;var r=n.anchorOffset,o=n.focusNode;n=n.focusOffset;try{a.nodeType,o.nodeType}catch(v){a=null;break e}var s=0,l=-1,u=-1,c=0,m=0,g=e,h=null;t:for(;;){for(var L;;){if(g!==a||r!==0&&g.nodeType!==3||(l=s+r),g!==o||n!==0&&g.nodeType!==3||(u=s+n),g.nodeType===3&&(s+=g.nodeValue.length),(L=g.firstChild)===null)break;h=g,g=L}for(;;){if(g===e)break t;if(h===a&&++c===r&&(l=s),h===o&&++m===n&&(u=s),(L=g.nextSibling)!==null)break;g=h,h=g.parentNode}g=L}a=l===-1||u===-1?null:{start:l,end:u}}else a=null}a=a||{start:0,end:0}}else a=null;jl={focusedElem:e,selectionRange:a},jo=!1;for(R=t;R!==null;)if(t=R,e=t.child,(t.subtreeFlags&1028)!==0&&e!==null)e.return=t,R=e;else for(;R!==null;){t=R;try{var x=t.alternate;if((t.flags&1024)!==0)switch(t.tag){case 0:case 11:case 15:break;case 1:if(x!==null){var C=x.memoizedProps,E=x.memoizedState,d=t.stateNode,i=d.getSnapshotBeforeUpdate(t.elementType===t.type?C:ft(t.type,C),E);d.__reactInternalSnapshotBeforeUpdate=i}break;case 3:var p=t.stateNode.containerInfo;p.nodeType===1?p.textContent="":p.nodeType===9&&p.documentElement&&p.removeChild(p.documentElement);break;case 5:case 6:case 4:case 17:break;default:throw Error(k(163))}}catch(v){de(t,t.return,v)}if(e=t.sibling,e!==null){e.return=t.return,R=e;break}R=t.return}return x=Td,Td=!1,x}function or(e,t,a){var n=t.updateQueue;if(n=n!==null?n.lastEffect:null,n!==null){var r=n=n.next;do{if((r.tag&e)===e){var o=r.destroy;r.destroy=void 0,o!==void 0&&uu(t,a,o)}r=r.next}while(r!==n)}}function Ls(e,t){if(t=t.updateQueue,t=t!==null?t.lastEffect:null,t!==null){var a=t=t.next;do{if((a.tag&e)===e){var n=a.create;a.destroy=n()}a=a.next}while(a!==t)}}function iu(e){var t=e.ref;if(t!==null){var a=e.stateNode;switch(e.tag){case 5:e=a;break;default:e=a}typeof t==="function"?t(e):t.current=e}}function Lc(e){var t=e.alternate;t!==null&&(e.alternate=null,Lc(t)),e.child=null,e.deletions=null,e.sibling=null,e.tag===5&&(t=e.stateNode,t!==null&&(delete t[bt],delete t[xr],delete t[$l],delete t[Qh],delete t[Yh])),e.stateNode=null,e.return=null,e.dependencies=null,e.memoizedProps=null,e.memoizedState=null,e.pendingProps=null,e.stateNode=null,e.updateQueue=null}function yc(e){return e.tag===5||e.tag===3||e.tag===4}function Rd(e){e:for(;;){for(;e.sibling===null;){if(e.return===null||yc(e.return))return null;e=e.return}e.sibling.return=e.return;for(e=e.sibling;e.tag!==5&&e.tag!==6&&e.tag!==18;){if(e.flags&2)continue e;if(e.child===null||e.tag===4)continue e;else e.child.return=e,e=e.child}if(!(e.flags&2))return e.stateNode}}function du(e,t,a){var n=e.tag;if(n===5||n===6)e=e.stateNode,t?a.nodeType===8?a.parentNode.insertBefore(e,t):a.insertBefore(e,t):(a.nodeType===8?(t=a.parentNode,t.insertBefore(e,a)):(t=a,t.appendChild(e)),a=a._reactRootContainer,a!==null&&a!==void 0||t.onclick!==null||(t.onclick=$o));else if(n!==4&&(e=e.child,e!==null))for(du(e,t,a),e=e.sibling;e!==null;)du(e,t,a),e=e.sibling}function fu(e,t,a){var n=e.tag;if(n===5||n===6)e=e.stateNode,t?a.insertBefore(e,t):a.appendChild(e);else if(n!==4&&(e=e.child,e!==null))for(fu(e,t,a),e=e.sibling;e!==null;)fu(e,t,a),e=e.sibling}function Wt(e,t,a){for(a=a.child;a!==null;)vc(e,t,a),a=a.sibling}function vc(e,t,a){if(Mt&&typeof Mt.onCommitFiberUnmount==="function")try{Mt.onCommitFiberUnmount(ds,a)}catch(l){}switch(a.tag){case 5:Fe||on(a,t);case 6:var n=Pe,r=ct;Pe=null,Wt(e,t,a),Pe=n,ct=r,Pe!==null&&(ct?(e=Pe,a=a.stateNode,e.nodeType===8?e.parentNode.removeChild(a):e.removeChild(a)):Pe.removeChild(a.stateNode));break;case 18:Pe!==null&&(ct?(e=Pe,a=a.stateNode,e.nodeType===8?cl(e.parentNode,a):e.nodeType===1&&cl(e,a),pr(e)):cl(Pe,a.stateNode));break;case 4:n=Pe,r=ct,Pe=a.stateNode.containerInfo,ct=!0,Wt(e,t,a),Pe=n,ct=r;break;case 0:case 11:case 14:case 15:if(!Fe&&(n=a.updateQueue,n!==null&&(n=n.lastEffect,n!==null))){r=n=n.next;do{var o=r,s=o.destroy;o=o.tag,s!==void 0&&((o&2)!==0?uu(a,t,s):(o&4)!==0&&uu(a,t,s)),r=r.next}while(r!==n)}Wt(e,t,a);break;case 1:if(!Fe&&(on(a,t),n=a.stateNode,typeof n.componentWillUnmount==="function"))try{n.props=a.memoizedProps,n.state=a.memoizedState,n.componentWillUnmount()}catch(l){de(a,t,l)}Wt(e,t,a);break;case 21:Wt(e,t,a);break;case 22:a.mode&1?(Fe=(n=Fe)||a.memoizedState!==null,Wt(e,t,a),Fe=n):Wt(e,t,a);break;default:Wt(e,t,a)}}function Fd(e){var t=e.updateQueue;if(t!==null){e.updateQueue=null;var a=e.stateNode;a===null&&(a=e.stateNode=new m0),t.forEach(function(n){var r=S0.bind(null,e,n);a.has(n)||(a.add(n),n.then(r,r))})}}function dt(e,t){var a=t.deletions;if(a!==null)for(var n=0;n<a.length;n++){var r=a[n];try{var o=e,s=t,l=s;e:for(;l!==null;){switch(l.tag){case 5:Pe=l.stateNode,ct=!1;break e;case 3:Pe=l.stateNode.containerInfo,ct=!0;break e;case 4:Pe=l.stateNode.containerInfo,ct=!0;break e}l=l.return}if(Pe===null)throw Error(k(160));vc(o,s,r),Pe=null,ct=!1;var u=r.alternate;u!==null&&(u.return=null),r.return=null}catch(c){de(r,t,c)}}if(t.subtreeFlags&12854)for(t=t.child;t!==null;)wc(t,e),t=t.sibling}function wc(e,t){var{alternate:a,flags:n}=e;switch(e.tag){case 0:case 11:case 14:case 15:if(dt(t,e),St(e),n&4){try{or(3,e,e.return),Ls(3,e)}catch(C){de(e,e.return,C)}try{or(5,e,e.return)}catch(C){de(e,e.return,C)}}break;case 1:dt(t,e),St(e),n&512&&a!==null&&on(a,a.return);break;case 5:if(dt(t,e),St(e),n&512&&a!==null&&on(a,a.return),e.flags&32){var r=e.stateNode;try{ir(r,"")}catch(C){de(e,e.return,C)}}if(n&4&&(r=e.stateNode,r!=null)){var o=e.memoizedProps,s=a!==null?a.memoizedProps:o,{type:l,updateQueue:u}=e;if(e.updateQueue=null,u!==null)try{l==="input"&&o.type==="radio"&&o.name!=null&&Gd(r,o),zl(l,s);var c=zl(l,o);for(s=0;s<u.length;s+=2){var m=u[s],g=u[s+1];m==="style"?Zd(r,g):m==="dangerouslySetInnerHTML"?Xd(r,g):m==="children"?ir(r,g):Lu(r,m,g,c)}switch(l){case"input":Ml(r,o);break;case"textarea":jd(r,o);break;case"select":var h=r._wrapperState.wasMultiple;r._wrapperState.wasMultiple=!!o.multiple;var L=o.value;L!=null?ln(r,!!o.multiple,L,!1):h!==!!o.multiple&&(o.defaultValue!=null?ln(r,!!o.multiple,o.defaultValue,!0):ln(r,!!o.multiple,o.multiple?[]:"",!1))}r[xr]=o}catch(C){de(e,e.return,C)}}break;case 6:if(dt(t,e),St(e),n&4){if(e.stateNode===null)throw Error(k(162));r=e.stateNode,o=e.memoizedProps;try{r.nodeValue=o}catch(C){de(e,e.return,C)}}break;case 3:if(dt(t,e),St(e),n&4&&a!==null&&a.memoizedState.isDehydrated)try{pr(t.containerInfo)}catch(C){de(e,e.return,C)}break;case 4:dt(t,e),St(e);break;case 13:dt(t,e),St(e),r=e.child,r.flags&8192&&(o=r.memoizedState!==null,r.stateNode.isHidden=o,!o||r.alternate!==null&&r.alternate.memoizedState!==null||(Ju=me())),n&4&&Fd(e);break;case 22:if(m=a!==null&&a.memoizedState!==null,e.mode&1?(Fe=(c=Fe)||m,dt(t,e),Fe=c):dt(t,e),St(e),n&8192){if(c=e.memoizedState!==null,(e.stateNode.isHidden=c)&&!m&&(e.mode&1)!==0)for(R=e,m=e.child;m!==null;){for(g=R=m;R!==null;){switch(h=R,L=h.child,h.tag){case 0:case 11:case 14:case 15:or(4,h,h.return);break;case 1:on(h,h.return);var x=h.stateNode;if(typeof x.componentWillUnmount==="function"){n=h,a=h.return;try{t=n,x.props=t.memoizedProps,x.state=t.memoizedState,x.componentWillUnmount()}catch(C){de(n,a,C)}}break;case 5:on(h,h.return);break;case 22:if(h.memoizedState!==null){Dd(g);continue}}L!==null?(L.return=h,R=L):Dd(g)}m=m.sibling}e:for(m=null,g=e;;){if(g.tag===5){if(m===null){m=g;try{r=g.stateNode,c?(o=r.style,typeof o.setProperty==="function"?o.setProperty("display","none","important"):o.display="none"):(l=g.stateNode,u=g.memoizedProps.style,s=u!==void 0&&u!==null&&u.hasOwnProperty("display")?u.display:null,l.style.display=$d("display",s))}catch(C){de(e,e.return,C)}}}else if(g.tag===6){if(m===null)try{g.stateNode.nodeValue=c?"":g.memoizedProps}catch(C){de(e,e.return,C)}}else if((g.tag!==22&&g.tag!==23||g.memoizedState===null||g===e)&&g.child!==null){g.child.return=g,g=g.child;continue}if(g===e)break e;for(;g.sibling===null;){if(g.return===null||g.return===e)break e;m===g&&(m=null),g=g.return}m===g&&(m=null),g.sibling.return=g.return,g=g.sibling}}break;case 19:dt(t,e),St(e),n&4&&Fd(e);break;case 21:break;default:dt(t,e),St(e)}}function St(e){var t=e.flags;if(t&2){try{e:{for(var a=e.return;a!==null;){if(yc(a)){var n=a;break e}a=a.return}throw Error(k(160))}switch(n.tag){case 5:var r=n.stateNode;n.flags&32&&(ir(r,""),n.flags&=-33);var o=Rd(e);fu(e,o,r);break;case 3:case 4:var s=n.stateNode.containerInfo,l=Rd(e);du(e,l,s);break;default:throw Error(k(161))}}catch(u){de(e,e.return,u)}e.flags&=-3}t&4096&&(e.flags&=-4097)}function g0(e,t,a){R=e,Ic(e,t,a)}function Ic(e,t,a){for(var n=(e.mode&1)!==0;R!==null;){var r=R,o=r.child;if(r.tag===22&&n){var s=r.memoizedState!==null||Mo;if(!s){var l=r.alternate,u=l!==null&&l.memoizedState!==null||Fe;l=Mo;var c=Fe;if(Mo=s,(Fe=u)&&!c)for(R=r;R!==null;)s=R,u=s.child,s.tag===22&&s.memoizedState!==null?Bd(r):u!==null?(u.return=s,R=u):Bd(r);for(;o!==null;)R=o,Ic(o,t,a),o=o.sibling;R=r,Mo=l,Fe=c}zd(e,t,a)}else(r.subtreeFlags&8772)!==0&&o!==null?(o.return=r,R=o):zd(e,t,a)}}function zd(e){for(;R!==null;){var t=R;if((t.flags&8772)!==0){var a=t.alternate;try{if((t.flags&8772)!==0)switch(t.tag){case 0:case 11:case 15:Fe||Ls(5,t);break;case 1:var n=t.stateNode;if(t.flags&4&&!Fe)if(a===null)n.componentDidMount();else{var r=t.elementType===t.type?a.memoizedProps:ft(t.type,a.memoizedProps);n.componentDidUpdate(r,a.memoizedState,n.__reactInternalSnapshotBeforeUpdate)}var o=t.updateQueue;o!==null&&xd(t,o,n);break;case 3:var s=t.updateQueue;if(s!==null){if(a=null,t.child!==null)switch(t.child.tag){case 5:a=t.child.stateNode;break;case 1:a=t.child.stateNode}xd(t,s,a)}break;case 5:var l=t.stateNode;if(a===null&&t.flags&4){a=l;var u=t.memoizedProps;switch(t.type){case"button":case"input":case"select":case"textarea":u.autoFocus&&a.focus();break;case"img":u.src&&(a.src=u.src)}}break;case 6:break;case 4:break;case 12:break;case 13:if(t.memoizedState===null){var c=t.alternate;if(c!==null){var m=c.memoizedState;if(m!==null){var g=m.dehydrated;g!==null&&pr(g)}}}break;case 19:case 17:case 21:case 22:case 23:case 25:break;default:throw Error(k(163))}Fe||t.flags&512&&iu(t)}catch(h){de(t,t.return,h)}}if(t===e){R=null;break}if(a=t.sibling,a!==null){a.return=t.return,R=a;break}R=t.return}}function Dd(e){for(;R!==null;){var t=R;if(t===e){R=null;break}var a=t.sibling;if(a!==null){a.return=t.return,R=a;break}R=t.return}}function Bd(e){for(;R!==null;){var t=R;try{switch(t.tag){case 0:case 11:case 15:var a=t.return;try{Ls(4,t)}catch(u){de(t,a,u)}break;case 1:var n=t.stateNode;if(typeof n.componentDidMount==="function"){var r=t.return;try{n.componentDidMount()}catch(u){de(t,r,u)}}var o=t.return;try{iu(t)}catch(u){de(t,o,u)}break;case 5:var s=t.return;try{iu(t)}catch(u){de(t,s,u)}}}catch(u){de(t,t.return,u)}if(t===e){R=null;break}var l=t.sibling;if(l!==null){l.return=t.return,R=l;break}R=t.return}}function _e(){return(H&6)!==0?me():Oo!==-1?Oo:Oo=me()}function aa(e){if((e.mode&1)===0)return 1;if((H&2)!==0&&be!==0)return be&-be;if(e0.transition!==null)return No===0&&(No=of()),No;if(e=K,e!==0)return e;return e=window.event,e=e===void 0?16:pf(e.type),e}function ht(e,t,a,n){if(50<lr)throw lr=0,pu=null,Error(k(185));if(Cr(e,a,n),(H&2)===0||e!==Ie)e===Ie&&((H&2)===0&&(ys|=a),Le===4&&Kt(e,be)),We(e,n),a===1&&H===0&&(t.mode&1)===0&&(vn=me()+500,hs&&ua())}function We(e,t){var a=e.callbackNode;ah(e,t);var n=Go(e,e===Ie?be:0);if(n===0)a!==null&&Gi(a),e.callbackNode=null,e.callbackPriority=0;else if(t=n&-n,e.callbackPriority!==t){if(a!=null&&Gi(a),t===1)e.tag===0?Jh(Ed.bind(null,e)):Ff(Ed.bind(null,e)),$h(function(){(H&6)===0&&ua()}),a=null;else{switch(sf(n)){case 1:a=ku;break;case 4:a=nf;break;case 16:a=Vo;break;case 536870912:a=rf;break;default:a=Vo}a=Tc(a,kc.bind(null,e))}e.callbackPriority=t,e.callbackNode=a}}function kc(e,t){if(Oo=-1,No=0,(H&6)!==0)throw Error(k(327));var a=e.callbackNode;if(pn()&&e.callbackNode!==a)return null;var n=Go(e,e===Ie?be:0);if(n===0)return null;if((n&30)!==0||(n&e.expiredLanes)!==0||t)t=is(e,n);else{t=n;var r=H;H|=2;var o=Sc();if(Ie!==e||be!==t)zt=null,vn=me()+500,ba(e,t);do try{w0();break}catch(l){Cc(e,l)}while(1);Ou(),ss.current=o,H=r,ge!==null?t=0:(Ie=null,be=0,t=Le)}if(t!==0){if(t===2&&(r=Ol(e),r!==0&&(n=r,t=mu(e,r))),t===1)throw a=kr,ba(e,0),Kt(e,n),We(e,me()),a;if(t===6)Kt(e,n);else{if(r=e.current.alternate,(n&30)===0&&!L0(r)&&(t=is(e,n),t===2&&(o=Ol(e),o!==0&&(n=o,t=mu(e,o))),t===1))throw a=kr,ba(e,0),Kt(e,n),We(e,me()),a;switch(e.finishedWork=r,e.finishedLanes=n,t){case 0:case 1:throw Error(k(345));case 2:ka(e,Ne,zt);break;case 3:if(Kt(e,n),(n&130023424)===n&&(t=Ju+500-me(),10<t)){if(Go(e,0)!==0)break;if(r=e.suspendedLanes,(r&n)!==n){_e(),e.pingedLanes|=e.suspendedLanes&r;break}e.timeoutHandle=Xl(ka.bind(null,e,Ne,zt),t);break}ka(e,Ne,zt);break;case 4:if(Kt(e,n),(n&4194240)===n)break;t=e.eventTimes;for(r=-1;0<n;){var s=31-mt(n);o=1<<s,s=t[s],s>r&&(r=s),n&=~o}if(n=r,n=me()-n,n=(120>n?120:480>n?480:1080>n?1080:1920>n?1920:3000>n?3000:4320>n?4320:1960*x0(n/1960))-n,10<n){e.timeoutHandle=Xl(ka.bind(null,e,Ne,zt),n);break}ka(e,Ne,zt);break;case 5:ka(e,Ne,zt);break;default:throw Error(k(329))}}}return We(e,me()),e.callbackNode===a?kc.bind(null,e):null}function mu(e,t){var a=sr;return e.current.memoizedState.isDehydrated&&(ba(e,t).flags|=256),e=is(e,t),e!==2&&(t=Ne,Ne=a,t!==null&&hu(t)),e}function hu(e){Ne===null?Ne=e:Ne.push.apply(Ne,e)}function L0(e){for(var t=e;;){if(t.flags&16384){var a=t.updateQueue;if(a!==null&&(a=a.stores,a!==null))for(var n=0;n<a.length;n++){var r=a[n],o=r.getSnapshot;r=r.value;try{if(!gt(o(),r))return!1}catch(s){return!1}}}if(a=t.child,t.subtreeFlags&16384&&a!==null)a.return=t,t=a;else{if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return!0;t=t.return}t.sibling.return=t.return,t=t.sibling}}return!0}function Kt(e,t){t&=~Yu,t&=~ys,e.suspendedLanes|=t,e.pingedLanes&=~t;for(e=e.expirationTimes;0<t;){var a=31-mt(t),n=1<<a;e[a]=-1,t&=~n}}function Ed(e){if((H&6)!==0)throw Error(k(327));pn();var t=Go(e,0);if((t&1)===0)return We(e,me()),null;var a=is(e,t);if(e.tag!==0&&a===2){var n=Ol(e);n!==0&&(t=n,a=mu(e,n))}if(a===1)throw a=kr,ba(e,0),Kt(e,t),We(e,me()),a;if(a===6)throw Error(k(345));return e.finishedWork=e.current.alternate,e.finishedLanes=t,ka(e,Ne,zt),We(e,me()),null}function y0(e,t){var a=H;H|=1;try{return e(t)}finally{H=a,H===0&&(vn=me()+500,hs&&ua())}}function vs(e){$t!==null&&$t.tag===0&&(H&6)===0&&pn();var t=H;H|=1;var a=tt.transition,n=K;try{if(tt.transition=null,K=1,e)return e()}finally{K=n,tt.transition=a,H=t,(H&6)===0&&ua()}}function ei(){Ge=sn.current,ae(sn)}function ba(e,t){e.finishedWork=null,e.finishedLanes=0;var a=e.timeoutHandle;if(a!==-1&&(e.timeoutHandle=-1,Xh(a)),ge!==null)for(a=ge.return;a!==null;){var n=a;switch(Bu(n),n.tag){case 1:n=n.type.childContextTypes,n!==null&&n!==void 0&&Zo();break;case 3:Ln(),ae(qe),ae(ze),Vu();break;case 5:Wu(n);break;case 4:Ln();break;case 13:ae(oe);break;case 19:ae(oe);break;case 10:Nu(n.type._context);break;case 22:case 23:ei()}a=a.return}if(Ie=e,ge=e=na(e.current,null),be=Ge=t,Le=0,kr=null,Yu=ys=Fa=0,Ne=sr=null,Sa!==null){for(t=0;t<Sa.length;t++)if(a=Sa[t],n=a.interleaved,n!==null){a.interleaved=null;var r=n.next,o=a.pending;if(o!==null){var s=o.next;o.next=r,n.next=s}a.pending=n}Sa=null}return e}function Cc(e,t){do{var a=ge;try{if(Ou(),Bo.current=os,rs){for(var n=se.memoizedState;n!==null;){var r=n.queue;r!==null&&(r.pending=null),n=n.next}rs=!1}if(Ra=0,we=xe=se=null,rr=!1,vr=0,Qu.current=null,a===null||a.return===null){Le=1,kr=t,ge=null;break}e:{var o=e,s=a.return,l=a,u=t;if(t=be,l.flags|=32768,u!==null&&typeof u==="object"&&typeof u.then==="function"){var c=u,m=l,g=m.tag;if((m.mode&1)===0&&(g===0||g===11||g===15)){var h=m.alternate;h?(m.updateQueue=h.updateQueue,m.memoizedState=h.memoizedState,m.lanes=h.lanes):(m.updateQueue=null,m.memoizedState=null)}var L=kd(s);if(L!==null){L.flags&=-257,Cd(L,s,l,o,t),L.mode&1&&Id(o,c,t),t=L,u=c;var x=t.updateQueue;if(x===null){var C=new Set;C.add(u),t.updateQueue=C}else x.add(u);break e}else{if((t&1)===0){Id(o,c,t),ti();break e}u=Error(k(426))}}else if(ne&&l.mode&1){var E=kd(s);if(E!==null){(E.flags&65536)===0&&(E.flags|=256),Cd(E,s,l,o,t),Eu(yn(u,l));break e}}o=u=yn(u,l),Le!==4&&(Le=2),sr===null?sr=[o]:sr.push(o),o=s;do{switch(o.tag){case 3:o.flags|=65536,t&=-t,o.lanes|=t;var d=lc(o,u,t);gd(o,d);break e;case 1:l=u;var i=o.type,p=o.stateNode;if((o.flags&128)===0&&(typeof i.getDerivedStateFromError==="function"||p!==null&&typeof p.componentDidCatch==="function"&&(ta===null||!ta.has(p)))){o.flags|=65536,t&=-t,o.lanes|=t;var v=uc(o,l,t);gd(o,v);break e}}o=o.return}while(o!==null)}bc(a)}catch(w){t=w,ge===a&&a!==null&&(ge=a=a.return);continue}break}while(1)}function Sc(){var e=ss.current;return ss.current=os,e===null?os:e}function ti(){if(Le===0||Le===3||Le===2)Le=4;Ie===null||(Fa&268435455)===0&&(ys&268435455)===0||Kt(Ie,be)}function is(e,t){var a=H;H|=2;var n=Sc();if(Ie!==e||be!==t)zt=null,ba(e,t);do try{v0();break}catch(r){Cc(e,r)}while(1);if(Ou(),H=a,ss.current=n,ge!==null)throw Error(k(261));return Ie=null,be=0,Le}function v0(){for(;ge!==null;)Pc(ge)}function w0(){for(;ge!==null&&!Km();)Pc(ge)}function Pc(e){var t=Ac(e.alternate,e,Ge);e.memoizedProps=e.pendingProps,t===null?bc(e):ge=t,Qu.current=null}function bc(e){var t=e;do{var a=t.alternate;if(e=t.return,(t.flags&32768)===0){if(a=c0(a,t,Ge),a!==null){ge=a;return}}else{if(a=p0(a,t),a!==null){a.flags&=32767,ge=a;return}if(e!==null)e.flags|=32768,e.subtreeFlags=0,e.deletions=null;else{Le=6,ge=null;return}}if(t=t.sibling,t!==null){ge=t;return}ge=t=e}while(t!==null);Le===0&&(Le=5)}function ka(e,t,a){var n=K,r=tt.transition;try{tt.transition=null,K=1,I0(e,t,a,n)}finally{tt.transition=r,K=n}return null}function I0(e,t,a,n){do pn();while($t!==null);if((H&6)!==0)throw Error(k(327));a=e.finishedWork;var r=e.finishedLanes;if(a===null)return null;if(e.finishedWork=null,e.finishedLanes=0,a===e.current)throw Error(k(177));e.callbackNode=null,e.callbackPriority=0;var o=a.lanes|a.childLanes;if(nh(e,o),e===Ie&&(ge=Ie=null,be=0),(a.subtreeFlags&2064)===0&&(a.flags&2064)===0||Ao||(Ao=!0,Tc(Vo,function(){return pn(),null})),o=(a.flags&15990)!==0,(a.subtreeFlags&15990)!==0||o){o=tt.transition,tt.transition=null;var s=K;K=1;var l=H;H|=4,Qu.current=null,h0(e,a),wc(a,e),Wh(jl),jo=!!Gl,jl=Gl=null,e.current=a,g0(a,e,r),Xm(),H=l,K=s,tt.transition=o}else e.current=a;if(Ao&&(Ao=!1,$t=e,us=r),o=e.pendingLanes,o===0&&(ta=null),Qm(a.stateNode,n),We(e,me()),t!==null)for(n=e.onRecoverableError,a=0;a<t.length;a++)r=t[a],n(r.value,{componentStack:r.stack,digest:r.digest});if(ls)throw ls=!1,e=cu,cu=null,e;return(us&1)!==0&&e.tag!==0&&pn(),o=e.pendingLanes,(o&1)!==0?e===pu?lr++:(lr=0,pu=e):lr=0,ua(),null}function pn(){if($t!==null){var e=sf(us),t=tt.transition,a=K;try{if(tt.transition=null,K=16>e?16:e,$t===null)var n=!1;else{if(e=$t,$t=null,us=0,(H&6)!==0)throw Error(k(331));var r=H;H|=4;for(R=e.current;R!==null;){var o=R,s=o.child;if((R.flags&16)!==0){var l=o.deletions;if(l!==null){for(var u=0;u<l.length;u++){var c=l[u];for(R=c;R!==null;){var m=R;switch(m.tag){case 0:case 11:case 15:or(8,m,o)}var g=m.child;if(g!==null)g.return=m,R=g;else for(;R!==null;){m=R;var h=m.sibling,L=m.return;if(Lc(m),m===c){R=null;break}if(h!==null){h.return=L,R=h;break}R=L}}}var x=o.alternate;if(x!==null){var C=x.child;if(C!==null){x.child=null;do{var E=C.sibling;C.sibling=null,C=E}while(C!==null)}}R=o}}if((o.subtreeFlags&2064)!==0&&s!==null)s.return=o,R=s;else e:for(;R!==null;){if(o=R,(o.flags&2048)!==0)switch(o.tag){case 0:case 11:case 15:or(9,o,o.return)}var d=o.sibling;if(d!==null){d.return=o.return,R=d;break e}R=o.return}}var i=e.current;for(R=i;R!==null;){s=R;var p=s.child;if((s.subtreeFlags&2064)!==0&&p!==null)p.return=s,R=p;else e:for(s=i;R!==null;){if(l=R,(l.flags&2048)!==0)try{switch(l.tag){case 0:case 11:case 15:Ls(9,l)}}catch(w){de(l,l.return,w)}if(l===s){R=null;break e}var v=l.sibling;if(v!==null){v.return=l.return,R=v;break e}R=l.return}}if(H=r,ua(),Mt&&typeof Mt.onPostCommitFiberRoot==="function")try{Mt.onPostCommitFiberRoot(ds,e)}catch(w){}n=!0}return n}finally{K=a,tt.transition=t}}return!1}function _d(e,t,a){t=yn(a,t),t=lc(e,t,1),e=ea(e,t,1),t=_e(),e!==null&&(Cr(e,1,t),We(e,t))}function de(e,t,a){if(e.tag===3)_d(e,e,a);else for(;t!==null;){if(t.tag===3){_d(t,e,a);break}else if(t.tag===1){var n=t.stateNode;if(typeof t.type.getDerivedStateFromError==="function"||typeof n.componentDidCatch==="function"&&(ta===null||!ta.has(n))){e=yn(a,e),e=uc(t,e,1),t=ea(t,e,1),e=_e(),t!==null&&(Cr(t,1,e),We(t,e));break}}t=t.return}}function k0(e,t,a){var n=e.pingCache;n!==null&&n.delete(t),t=_e(),e.pingedLanes|=e.suspendedLanes&a,Ie===e&&(be&a)===a&&(Le===4||Le===3&&(be&130023424)===be&&500>me()-Ju?ba(e,0):Yu|=a),We(e,t)}function Mc(e,t){t===0&&((e.mode&1)===0?t=1:(t=yo,yo<<=1,(yo&130023424)===0&&(yo=4194304)));var a=_e();e=Nt(e,t),e!==null&&(Cr(e,t,a),We(e,a))}function C0(e){var t=e.memoizedState,a=0;t!==null&&(a=t.retryLane),Mc(e,a)}function S0(e,t){var a=0;switch(e.tag){case 13:var{stateNode:n,memoizedState:r}=e;r!==null&&(a=r.retryLane);break;case 19:n=e.stateNode;break;default:throw Error(k(314))}n!==null&&n.delete(t),Mc(e,a)}function Tc(e,t){return af(e,t)}function P0(e,t,a,n){this.tag=e,this.key=a,this.sibling=this.child=this.return=this.stateNode=this.type=this.elementType=null,this.index=0,this.ref=null,this.pendingProps=t,this.dependencies=this.memoizedState=this.updateQueue=this.memoizedProps=null,this.mode=n,this.subtreeFlags=this.flags=0,this.deletions=null,this.childLanes=this.lanes=0,this.alternate=null}function et(e,t,a,n){return new P0(e,t,a,n)}function ai(e){return e=e.prototype,!(!e||!e.isReactComponent)}function b0(e){if(typeof e==="function")return ai(e)?1:0;if(e!==void 0&&e!==null){if(e=e.$$typeof,e===vu)return 11;if(e===wu)return 14}return 2}function na(e,t){var a=e.alternate;return a===null?(a=et(e.tag,t,e.key,e.mode),a.elementType=e.elementType,a.type=e.type,a.stateNode=e.stateNode,a.alternate=e,e.alternate=a):(a.pendingProps=t,a.type=e.type,a.flags=0,a.subtreeFlags=0,a.deletions=null),a.flags=e.flags&14680064,a.childLanes=e.childLanes,a.lanes=e.lanes,a.child=e.child,a.memoizedProps=e.memoizedProps,a.memoizedState=e.memoizedState,a.updateQueue=e.updateQueue,t=e.dependencies,a.dependencies=t===null?null:{lanes:t.lanes,firstContext:t.firstContext},a.sibling=e.sibling,a.index=e.index,a.ref=e.ref,a}function Uo(e,t,a,n,r,o){var s=2;if(n=e,typeof e==="function")ai(e)&&(s=1);else if(typeof e==="string")s=5;else e:switch(e){case Qa:return Ma(a.children,r,o,t);case yu:s=8,r|=8;break;case kl:return e=et(12,a,t,r|2),e.elementType=kl,e.lanes=o,e;case Cl:return e=et(13,a,t,r),e.elementType=Cl,e.lanes=o,e;case Sl:return e=et(19,a,t,r),e.elementType=Sl,e.lanes=o,e;case Hd:return ws(a,r,o,t);default:if(typeof e==="object"&&e!==null)switch(e.$$typeof){case Ud:s=10;break e;case qd:s=9;break e;case vu:s=11;break e;case wu:s=14;break e;case Vt:s=16,n=null;break e}throw Error(k(130,e==null?e:typeof e,""))}return t=et(s,a,t,r),t.elementType=e,t.type=n,t.lanes=o,t}function Ma(e,t,a,n){return e=et(7,e,n,t),e.lanes=a,e}function ws(e,t,a,n){return e=et(22,e,n,t),e.elementType=Hd,e.lanes=a,e.stateNode={isHidden:!1},e}function vl(e,t,a){return e=et(6,e,null,t),e.lanes=a,e}function wl(e,t,a){return t=et(4,e.children!==null?e.children:[],e.key,t),t.lanes=a,t.stateNode={containerInfo:e.containerInfo,pendingChildren:null,implementation:e.implementation},t}function M0(e,t,a,n,r){this.tag=t,this.containerInfo=e,this.finishedWork=this.pingCache=this.current=this.pendingChildren=null,this.timeoutHandle=-1,this.callbackNode=this.pendingContext=this.context=null,this.callbackPriority=0,this.eventTimes=ol(0),this.expirationTimes=ol(-1),this.entangledLanes=this.finishedLanes=this.mutableReadLanes=this.expiredLanes=this.pingedLanes=this.suspendedLanes=this.pendingLanes=0,this.entanglements=ol(0),this.identifierPrefix=n,this.onRecoverableError=r,this.mutableSourceEagerHydrationData=null}function Rc(e,t,a,n,r,o,s,l,u){return e=new M0(e,t,a,l,u),t===1?(t=1,o===!0&&(t|=8)):t=0,o=et(3,null,null,t),e.current=o,o.stateNode=e,o.memoizedState={element:n,isDehydrated:a,cache:null,transitions:null,pendingSuspenseBoundaries:null},qu(o),e}function Fc(e){if(!e)return oa;e=e._reactInternals;e:{if(Da(e)!==e||e.tag!==1)throw Error(k(170));var t=e;do{switch(t.tag){case 3:t=t.stateNode.context;break e;case 1:if(He(t.type)){t=t.stateNode.__reactInternalMemoizedMergedChildContext;break e}}t=t.return}while(t!==null);throw Error(k(171))}if(e.tag===1){var a=e.type;if(He(a))return Rf(e,a,t)}return t}function A0(e,t,a,n,r,o,s,l,u){return e=Rc(a,n,!0,e,r,o,s,l,u),e.context=Fc(null),a=e.current,n=_e(),r=aa(a),o=_t(n,r),o.callback=t!==void 0&&t!==null?t:null,ea(a,o,r),e.current.lanes=r,Cr(e,r,n),We(e,n),e}function zc(e,t,a,n){var r=t.current,o=_e(),s=aa(r);return a=Fc(a),t.context===null?t.context=a:t.pendingContext=a,t=_t(o,s),t.payload={element:e},n=n===void 0?null:n,n!==null&&(t.callback=n),e=ea(r,t,s),e!==null&&(ht(e,r,s,o),Do(e,r,s)),s}function Od(e,t){if(e=e.memoizedState,e!==null&&e.dehydrated!==null){var a=e.retryLane;e.retryLane=a!==0&&a<t?a:t}}function ni(e,t){Od(e,t),(e=e.alternate)&&Od(e,t)}function T0(){return null}function ri(e){this._internalRoot=e}function Is(e){this._internalRoot=e}function Bc(e){return!(!e||e.nodeType!==1&&e.nodeType!==9&&e.nodeType!==11)}var re,Nd,ur,Ot,Il,Tm,Ei,_i,Me,gu,qt,ho,Wn,Qa,yu,kl,Ud,qd,vu,Cl,Sl,wu,Vt,Hd,Oi,le,tl,al=!1,Gn,xo,Xd,Jn,_m,Om,Dl=null,Bl=null,un=null,dn=null,rl=!1,El=!1,wa,er=!1,Ho=null,Wo=!1,_l=null,Hm,af,Gi,Km,Xm,me,$m,ku,nf,Vo,Zm,rf,ds=null,Mt=null,mt,Ym,Jm,Lo=64,yo=4194304,K=0,lf,Su,uf,df,ff,Nl=!1,vo,Zt=null,Qt=null,Yt=null,fr,cr,jt,rh,fn,jo=!0,Ko=null,Xt=null,bu=null,Ro=null,wn,Mu,Sr,ih,sl,ll,Nn,fs,$i,dh,fh,ch,ul,ph,mh,hh,gh,xh,Zi,Lh,yh,vh,Ih,kh,Ch,Qi,Sh,Ph,bh,Mh,Ah,Th,Rh,Tu,tr=null,Fh,hf,Yi,Ji=!1,Ya=!1,Bh,ar=null,mr=null,yf=!1,Kn,Xn,zo,gt,Vh,Ja=null,ql=null,nr=null,Hl=!1,en,il,kf,Cf,Sf,Pf,bf,Mf,od,Zn,Wl,Vl,$n,Qn,Gh,ko,jh,Kh,Gl=null,jl=null,Xl,Xh,id,$h,In,bt,xr,kn,$l,Qh,Yh,Zl,tn=-1,oa,ze,qe,Aa,Dt=null,hs=!1,pl=!1,an,nn=0,Yo=null,Jo=0,Ye,Je=0,Ta=null,Bt=1,Et="",Ke=null,je=null,ne=!1,pt=null,e0,xn,_f,es,ts=null,rn=null,_u=null,Sa=null,Gt=!1,Pr,At,Lr,yr,oe,ml,Bo,hl,Ra=0,se=null,xe=null,we=null,rs=!1,rr=!1,vr=0,t0=0,os,o0,s0,l0,xs,u0,i0,Ue=!1,ou,hc,lu,gc,xc,Mo=!1,Fe=!1,m0,R=null,Td=!1,Pe=null,ct=!1,x0,ss,Qu,tt,H=0,Ie=null,ge=null,be=0,Ge=0,sn,Le=0,kr=null,Fa=0,ys=0,Yu=0,sr=null,Ne=null,Ju=0,vn=1/0,zt=null,ls=!1,cu=null,ta=null,Ao=!1,$t=null,us=0,lr=0,pu=null,Oo=-1,No=0,Ac,Dc,Hn,R0,Za,oi=function(e,t){if(!Bc(e))throw Error(k(299));var a=!1,n="",r=Dc;return t!==null&&t!==void 0&&(t.unstable_strictMode===!0&&(a=!0),t.identifierPrefix!==void 0&&(n=t.identifierPrefix),t.onRecoverableError!==void 0&&(r=t.onRecoverableError)),t=Rc(e,1,!1,null,null,a,!1,n,r),e[kn]=t.current,Fu(e.nodeType===8?e.parentNode:e),new ri(t)},ks=function(e){return vs(e)},si=function(e,t,a){if(!Bc(e))throw Error(k(405));var n=a!=null&&a.hydratedSources||null,r=!1,o="",s=Dc;if(a!==null&&a!==void 0&&(a.unstable_strictMode===!0&&(r=!0),a.identifierPrefix!==void 0&&(o=a.identifierPrefix),a.onRecoverableError!==void 0&&(s=a.onRecoverableError)),t=A0(t,null,e,1,a!=null?a:null,r,!1,o,s),e[kn]=t.current,Fu(e),n)for(e=0;e<n.length;e++)a=n[e],r=a._getVersion,r=r(a._source),t.mutableSourceEagerHydrationData==null?t.mutableSourceEagerHydrationData=[a,r]:t.mutableSourceEagerHydrationData.push(a,r);return new Is(t)};var Ec=Hs(()=>{ut();re=wi(Bi());Nd=new Set,ur={};Ot=!(typeof window>"u"||typeof window.document>"u"||typeof window.document.createElement>"u"),Il=Object.prototype.hasOwnProperty,Tm=/^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$/,Ei={},_i={};Me={};"children dangerouslySetInnerHTML defaultValue defaultChecked innerHTML suppressContentEditableWarning suppressHydrationWarning style".split(" ").forEach(function(e){Me[e]=new Oe(e,0,!1,e,null,!1,!1)});[["acceptCharset","accept-charset"],["className","class"],["htmlFor","for"],["httpEquiv","http-equiv"]].forEach(function(e){var t=e[0];Me[t]=new Oe(t,1,!1,e[1],null,!1,!1)});["contentEditable","draggable","spellCheck","value"].forEach(function(e){Me[e]=new Oe(e,2,!1,e.toLowerCase(),null,!1,!1)});["autoReverse","externalResourcesRequired","focusable","preserveAlpha"].forEach(function(e){Me[e]=new Oe(e,2,!1,e,null,!1,!1)});"allowFullScreen async autoFocus autoPlay controls default defer disabled disablePictureInPicture disableRemotePlayback formNoValidate hidden loop noModule noValidate open playsInline readOnly required reversed scoped seamless itemScope".split(" ").forEach(function(e){Me[e]=new Oe(e,3,!1,e.toLowerCase(),null,!1,!1)});["checked","multiple","muted","selected"].forEach(function(e){Me[e]=new Oe(e,3,!0,e,null,!1,!1)});["capture","download"].forEach(function(e){Me[e]=new Oe(e,4,!1,e,null,!1,!1)});["cols","rows","size","span"].forEach(function(e){Me[e]=new Oe(e,6,!1,e,null,!1,!1)});["rowSpan","start"].forEach(function(e){Me[e]=new Oe(e,5,!1,e.toLowerCase(),null,!1,!1)});gu=/[\-:]([a-z])/g;"accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y word-spacing writing-mode xmlns:xlink x-height".split(" ").forEach(function(e){var t=e.replace(gu,xu);Me[t]=new Oe(t,1,!1,e,null,!1,!1)});"xlink:actuate xlink:arcrole xlink:role xlink:show xlink:title xlink:type".split(" ").forEach(function(e){var t=e.replace(gu,xu);Me[t]=new Oe(t,1,!1,e,"http://www.w3.org/1999/xlink",!1,!1)});["xml:base","xml:lang","xml:space"].forEach(function(e){var t=e.replace(gu,xu);Me[t]=new Oe(t,1,!1,e,"http://www.w3.org/XML/1998/namespace",!1,!1)});["tabIndex","crossOrigin"].forEach(function(e){Me[e]=new Oe(e,1,!1,e.toLowerCase(),null,!1,!1)});Me.xlinkHref=new Oe("xlinkHref",1,!1,"xlink:href","http://www.w3.org/1999/xlink",!0,!1);["src","href","action","formAction"].forEach(function(e){Me[e]=new Oe(e,1,!1,e.toLowerCase(),null,!0,!0)});qt=An,ho=Symbol.for("react.element"),Wn=Symbol.for("react.portal"),Qa=Symbol.for("react.fragment"),yu=Symbol.for("react.strict_mode"),kl=Symbol.for("react.profiler"),Ud=Symbol.for("react.provider"),qd=Symbol.for("react.context"),vu=Symbol.for("react.forward_ref"),Cl=Symbol.for("react.suspense"),Sl=Symbol.for("react.suspense_list"),wu=Symbol.for("react.memo"),Vt=Symbol.for("react.lazy"),Hd=Symbol.for("react.offscreen"),Oi=Symbol.iterator;le=Object.assign;Gn=Array.isArray;Xd=function(e){return typeof MSApp<"u"&&MSApp.execUnsafeLocalFunction?function(t,a,n,r){MSApp.execUnsafeLocalFunction(function(){return e(t,a,n,r)})}:e}(function(e,t){if(e.namespaceURI!=="http://www.w3.org/2000/svg"||"innerHTML"in e)e.innerHTML=t;else{xo=xo||document.createElement("div"),xo.innerHTML="<svg>"+t.valueOf().toString()+"</svg>";for(t=xo.firstChild;e.firstChild;)e.removeChild(e.firstChild);for(;t.firstChild;)e.appendChild(t.firstChild)}});Jn={animationIterationCount:!0,aspectRatio:!0,borderImageOutset:!0,borderImageSlice:!0,borderImageWidth:!0,boxFlex:!0,boxFlexGroup:!0,boxOrdinalGroup:!0,columnCount:!0,columns:!0,flex:!0,flexGrow:!0,flexPositive:!0,flexShrink:!0,flexNegative:!0,flexOrder:!0,gridArea:!0,gridRow:!0,gridRowEnd:!0,gridRowSpan:!0,gridRowStart:!0,gridColumn:!0,gridColumnEnd:!0,gridColumnSpan:!0,gridColumnStart:!0,fontWeight:!0,lineClamp:!0,lineHeight:!0,opacity:!0,order:!0,orphans:!0,tabSize:!0,widows:!0,zIndex:!0,zoom:!0,fillOpacity:!0,floodOpacity:!0,stopOpacity:!0,strokeDasharray:!0,strokeDashoffset:!0,strokeMiterlimit:!0,strokeOpacity:!0,strokeWidth:!0},_m=["Webkit","ms","Moz","O"];Object.keys(Jn).forEach(function(e){_m.forEach(function(t){t=t+e.charAt(0).toUpperCase()+e.substring(1),Jn[t]=Jn[e]})});Om=le({menuitem:!0},{area:!0,base:!0,br:!0,col:!0,embed:!0,hr:!0,img:!0,input:!0,keygen:!0,link:!0,meta:!0,param:!0,source:!0,track:!0,wbr:!0});if(Ot)try{wa={},Object.defineProperty(wa,"passive",{get:function(){El=!0}}),window.addEventListener("test",wa,wa),window.removeEventListener("test",wa,wa)}catch(e){El=!1}Hm={onError:function(e){er=!0,Ho=e}};af=re.unstable_scheduleCallback,Gi=re.unstable_cancelCallback,Km=re.unstable_shouldYield,Xm=re.unstable_requestPaint,me=re.unstable_now,$m=re.unstable_getCurrentPriorityLevel,ku=re.unstable_ImmediatePriority,nf=re.unstable_UserBlockingPriority,Vo=re.unstable_NormalPriority,Zm=re.unstable_LowPriority,rf=re.unstable_IdlePriority;mt=Math.clz32?Math.clz32:eh,Ym=Math.log,Jm=Math.LN2;vo=[],fr=new Map,cr=new Map,jt=[],rh="mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset submit".split(" ");fn=qt.ReactCurrentBatchConfig;wn={eventPhase:0,bubbles:0,cancelable:0,timeStamp:function(e){return e.timeStamp||Date.now()},defaultPrevented:0,isTrusted:0},Mu=Xe(wn),Sr=le({},wn,{view:0,detail:0}),ih=Xe(Sr),fs=le({},Sr,{screenX:0,screenY:0,clientX:0,clientY:0,pageX:0,pageY:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,getModifierState:Au,button:0,buttons:0,relatedTarget:function(e){return e.relatedTarget===void 0?e.fromElement===e.srcElement?e.toElement:e.fromElement:e.relatedTarget},movementX:function(e){if("movementX"in e)return e.movementX;return e!==Nn&&(Nn&&e.type==="mousemove"?(sl=e.screenX-Nn.screenX,ll=e.screenY-Nn.screenY):ll=sl=0,Nn=e),sl},movementY:function(e){return"movementY"in e?e.movementY:ll}}),$i=Xe(fs),dh=le({},fs,{dataTransfer:0}),fh=Xe(dh),ch=le({},Sr,{relatedTarget:0}),ul=Xe(ch),ph=le({},wn,{animationName:0,elapsedTime:0,pseudoElement:0}),mh=Xe(ph),hh=le({},wn,{clipboardData:function(e){return"clipboardData"in e?e.clipboardData:window.clipboardData}}),gh=Xe(hh),xh=le({},wn,{data:0}),Zi=Xe(xh),Lh={Esc:"Escape",Spacebar:" ",Left:"ArrowLeft",Up:"ArrowUp",Right:"ArrowRight",Down:"ArrowDown",Del:"Delete",Win:"OS",Menu:"ContextMenu",Apps:"ContextMenu",Scroll:"ScrollLock",MozPrintableKey:"Unidentified"},yh={8:"Backspace",9:"Tab",12:"Clear",13:"Enter",16:"Shift",17:"Control",18:"Alt",19:"Pause",20:"CapsLock",27:"Escape",32:" ",33:"PageUp",34:"PageDown",35:"End",36:"Home",37:"ArrowLeft",38:"ArrowUp",39:"ArrowRight",40:"ArrowDown",45:"Insert",46:"Delete",112:"F1",113:"F2",114:"F3",115:"F4",116:"F5",117:"F6",118:"F7",119:"F8",120:"F9",121:"F10",122:"F11",123:"F12",144:"NumLock",145:"ScrollLock",224:"Meta"},vh={Alt:"altKey",Control:"ctrlKey",Meta:"metaKey",Shift:"shiftKey"};Ih=le({},Sr,{key:function(e){if(e.key){var t=Lh[e.key]||e.key;if(t!=="Unidentified")return t}return e.type==="keypress"?(e=Fo(e),e===13?"Enter":String.fromCharCode(e)):e.type==="keydown"||e.type==="keyup"?yh[e.keyCode]||"Unidentified":""},code:0,location:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,repeat:0,locale:0,getModifierState:Au,charCode:function(e){return e.type==="keypress"?Fo(e):0},keyCode:function(e){return e.type==="keydown"||e.type==="keyup"?e.keyCode:0},which:function(e){return e.type==="keypress"?Fo(e):e.type==="keydown"||e.type==="keyup"?e.keyCode:0}}),kh=Xe(Ih),Ch=le({},fs,{pointerId:0,width:0,height:0,pressure:0,tangentialPressure:0,tiltX:0,tiltY:0,twist:0,pointerType:0,isPrimary:0}),Qi=Xe(Ch),Sh=le({},Sr,{touches:0,targetTouches:0,changedTouches:0,altKey:0,metaKey:0,ctrlKey:0,shiftKey:0,getModifierState:Au}),Ph=Xe(Sh),bh=le({},wn,{propertyName:0,elapsedTime:0,pseudoElement:0}),Mh=Xe(bh),Ah=le({},fs,{deltaX:function(e){return"deltaX"in e?e.deltaX:("wheelDeltaX"in e)?-e.wheelDeltaX:0},deltaY:function(e){return"deltaY"in e?e.deltaY:("wheelDeltaY"in e)?-e.wheelDeltaY:("wheelDelta"in e)?-e.wheelDelta:0},deltaZ:0,deltaMode:0}),Th=Xe(Ah),Rh=[9,13,27,32],Tu=Ot&&"CompositionEvent"in window;Ot&&"documentMode"in document&&(tr=document.documentMode);Fh=Ot&&"TextEvent"in window&&!tr,hf=Ot&&(!Tu||tr&&8<tr&&11>=tr),Yi=String.fromCharCode(32);Bh={color:!0,date:!0,datetime:!0,"datetime-local":!0,email:!0,month:!0,number:!0,password:!0,range:!0,search:!0,tel:!0,text:!0,time:!0,url:!0,week:!0};if(Ot){if(Ot){if(Xn="oninput"in document,!Xn)zo=document.createElement("div"),zo.setAttribute("oninput","return;"),Xn=typeof zo.oninput==="function";Kn=Xn}else Kn=!1;yf=Kn&&(!document.documentMode||9<document.documentMode)}gt=typeof Object.is==="function"?Object.is:Hh;Vh=Ot&&"documentMode"in document&&11>=document.documentMode;en={animationend:Io("Animation","AnimationEnd"),animationiteration:Io("Animation","AnimationIteration"),animationstart:Io("Animation","AnimationStart"),transitionend:Io("Transition","TransitionEnd")},il={},kf={};Ot&&(kf=document.createElement("div").style,("AnimationEvent"in window)||(delete en.animationend.animation,delete en.animationiteration.animation,delete en.animationstart.animation),("TransitionEvent"in window)||delete en.transitionend.transition);Cf=ps("animationend"),Sf=ps("animationiteration"),Pf=ps("animationstart"),bf=ps("transitionend"),Mf=new Map,od="abort auxClick cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");for($n=0;$n<od.length;$n++)Zn=od[$n],Wl=Zn.toLowerCase(),Vl=Zn[0].toUpperCase()+Zn.slice(1),sa(Wl,"on"+Vl);sa(Cf,"onAnimationEnd");sa(Sf,"onAnimationIteration");sa(Pf,"onAnimationStart");sa("dblclick","onDoubleClick");sa("focusin","onFocus");sa("focusout","onBlur");sa(bf,"onTransitionEnd");mn("onMouseEnter",["mouseout","mouseover"]);mn("onMouseLeave",["mouseout","mouseover"]);mn("onPointerEnter",["pointerout","pointerover"]);mn("onPointerLeave",["pointerout","pointerover"]);za("onChange","change click focusin focusout input keydown keyup selectionchange".split(" "));za("onSelect","focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" "));za("onBeforeInput",["compositionend","keypress","textInput","paste"]);za("onCompositionEnd","compositionend focusout keydown keypress keyup mousedown".split(" "));za("onCompositionStart","compositionstart focusout keydown keypress keyup mousedown".split(" "));za("onCompositionUpdate","compositionupdate focusout keydown keypress keyup mousedown".split(" "));Qn="abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" "),Gh=new Set("cancel close invalid load scroll toggle".split(" ").concat(Qn));ko="_reactListening"+Math.random().toString(36).slice(2);jh=/\r\n?/g,Kh=/\u0000|\uFFFD/g;Xl=typeof setTimeout==="function"?setTimeout:void 0,Xh=typeof clearTimeout==="function"?clearTimeout:void 0,id=typeof Promise==="function"?Promise:void 0,$h=typeof queueMicrotask==="function"?queueMicrotask:typeof id<"u"?function(e){return id.resolve(null).then(e).catch(Zh)}:Xl;In=Math.random().toString(36).slice(2),bt="__reactFiber$"+In,xr="__reactProps$"+In,kn="__reactContainer$"+In,$l="__reactEvents$"+In,Qh="__reactListeners$"+In,Yh="__reactHandles$"+In;Zl=[];oa={},ze=la(oa),qe=la(!1),Aa=oa;an=[],Ye=[];e0=qt.ReactCurrentBatchConfig;xn=Ef(!0),_f=Ef(!1),es=la(null);Pr={},At=la(Pr),Lr=la(Pr),yr=la(Pr);oe=la(0);ml=[];Bo=qt.ReactCurrentDispatcher,hl=qt.ReactCurrentBatchConfig;os={readContext:at,useCallback:Te,useContext:Te,useEffect:Te,useImperativeHandle:Te,useInsertionEffect:Te,useLayoutEffect:Te,useMemo:Te,useReducer:Te,useRef:Te,useState:Te,useDebugValue:Te,useDeferredValue:Te,useTransition:Te,useMutableSource:Te,useSyncExternalStore:Te,useId:Te,unstable_isNewReconciler:!1},o0={readContext:at,useCallback:function(e,t){return Pt().memoizedState=[e,t===void 0?null:t],e},useContext:at,useEffect:yd,useImperativeHandle:function(e,t,a){return a=a!==null&&a!==void 0?a.concat([e]):null,Eo(4194308,4,Qf.bind(null,t,e),a)},useLayoutEffect:function(e,t){return Eo(4194308,4,e,t)},useInsertionEffect:function(e,t){return Eo(4,2,e,t)},useMemo:function(e,t){var a=Pt();return t=t===void 0?null:t,e=e(),a.memoizedState=[e,t],e},useReducer:function(e,t,a){var n=Pt();return t=a!==void 0?a(t):t,n.memoizedState=n.baseState=t,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:e,lastRenderedState:t},n.queue=e,e=e.dispatch=n0.bind(null,se,e),[n.memoizedState,e]},useRef:function(e){var t=Pt();return e={current:e},t.memoizedState=e},useState:Ld,useDebugValue:$u,useDeferredValue:function(e){return Pt().memoizedState=e},useTransition:function(){var e=Ld(!1),t=e[0];return e=a0.bind(null,e[1]),Pt().memoizedState=e,[t,e]},useMutableSource:function(){},useSyncExternalStore:function(e,t,a){var n=se,r=Pt();if(ne){if(a===void 0)throw Error(k(407));a=a()}else{if(a=t(),Ie===null)throw Error(k(349));(Ra&30)!==0||Wf(n,t,a)}r.memoizedState=a;var o={value:a,getSnapshot:t};return r.queue=o,yd(Gf.bind(null,n,o,e),[e]),n.flags|=2048,Ir(9,Vf.bind(null,n,o,a,t),void 0,null),a},useId:function(){var e=Pt(),t=Ie.identifierPrefix;if(ne){var a=Et,n=Bt;a=(n&~(1<<32-mt(n)-1)).toString(32)+a,t=":"+t+"R"+a,a=vr++,0<a&&(t+="H"+a.toString(32)),t+=":"}else a=t0++,t=":"+t+"r"+a.toString(32)+":";return e.memoizedState=t},unstable_isNewReconciler:!1},s0={readContext:at,useCallback:Jf,useContext:at,useEffect:Xu,useImperativeHandle:Yf,useInsertionEffect:$f,useLayoutEffect:Zf,useMemo:ec,useReducer:gl,useRef:Xf,useState:function(){return gl(wr)},useDebugValue:$u,useDeferredValue:function(e){var t=nt();return tc(t,xe.memoizedState,e)},useTransition:function(){var e=gl(wr)[0],t=nt().memoizedState;return[e,t]},useMutableSource:qf,useSyncExternalStore:Hf,useId:ac,unstable_isNewReconciler:!1},l0={readContext:at,useCallback:Jf,useContext:at,useEffect:Xu,useImperativeHandle:Yf,useInsertionEffect:$f,useLayoutEffect:Zf,useMemo:ec,useReducer:xl,useRef:Xf,useState:function(){return xl(wr)},useDebugValue:$u,useDeferredValue:function(e){var t=nt();return xe===null?t.memoizedState=e:tc(t,xe.memoizedState,e)},useTransition:function(){var e=xl(wr)[0],t=nt().memoizedState;return[e,t]},useMutableSource:qf,useSyncExternalStore:Hf,useId:ac,unstable_isNewReconciler:!1};xs={isMounted:function(e){return(e=e._reactInternals)?Da(e)===e:!1},enqueueSetState:function(e,t,a){e=e._reactInternals;var n=_e(),r=aa(e),o=_t(n,r);o.payload=t,a!==void 0&&a!==null&&(o.callback=a),t=ea(e,o,r),t!==null&&(ht(t,e,r,n),Do(t,e,r))},enqueueReplaceState:function(e,t,a){e=e._reactInternals;var n=_e(),r=aa(e),o=_t(n,r);o.tag=1,o.payload=t,a!==void 0&&a!==null&&(o.callback=a),t=ea(e,o,r),t!==null&&(ht(t,e,r,n),Do(t,e,r))},enqueueForceUpdate:function(e,t){e=e._reactInternals;var a=_e(),n=aa(e),r=_t(a,n);r.tag=2,t!==void 0&&t!==null&&(r.callback=t),t=ea(e,r,n),t!==null&&(ht(t,e,n,a),Do(t,e,n))}};u0=typeof WeakMap==="function"?WeakMap:Map;i0=qt.ReactCurrentOwner;ou={dehydrated:null,treeContext:null,retryLane:0};hc=function(e,t){for(var a=t.child;a!==null;){if(a.tag===5||a.tag===6)e.appendChild(a.stateNode);else if(a.tag!==4&&a.child!==null){a.child.return=a,a=a.child;continue}if(a===t)break;for(;a.sibling===null;){if(a.return===null||a.return===t)return;a=a.return}a.sibling.return=a.return,a=a.sibling}};lu=function(){};gc=function(e,t,a,n){var r=e.memoizedProps;if(r!==n){e=t.stateNode,Pa(At.current);var o=null;switch(a){case"input":r=bl(e,r),n=bl(e,n),o=[];break;case"select":r=le({},r,{value:void 0}),n=le({},n,{value:void 0}),o=[];break;case"textarea":r=Tl(e,r),n=Tl(e,n),o=[];break;default:typeof r.onClick!=="function"&&typeof n.onClick==="function"&&(e.onclick=$o)}Fl(a,n);var s;a=null;for(c in r)if(!n.hasOwnProperty(c)&&r.hasOwnProperty(c)&&r[c]!=null)if(c==="style"){var l=r[c];for(s in l)l.hasOwnProperty(s)&&(a||(a={}),a[s]="")}else c!=="dangerouslySetInnerHTML"&&c!=="children"&&c!=="suppressContentEditableWarning"&&c!=="suppressHydrationWarning"&&c!=="autoFocus"&&(ur.hasOwnProperty(c)?o||(o=[]):(o=o||[]).push(c,null));for(c in n){var u=n[c];if(l=r!=null?r[c]:void 0,n.hasOwnProperty(c)&&u!==l&&(u!=null||l!=null))if(c==="style")if(l){for(s in l)!l.hasOwnProperty(s)||u&&u.hasOwnProperty(s)||(a||(a={}),a[s]="");for(s in u)u.hasOwnProperty(s)&&l[s]!==u[s]&&(a||(a={}),a[s]=u[s])}else a||(o||(o=[]),o.push(c,a)),a=u;else c==="dangerouslySetInnerHTML"?(u=u?u.__html:void 0,l=l?l.__html:void 0,u!=null&&l!==u&&(o=o||[]).push(c,u)):c==="children"?typeof u!=="string"&&typeof u!=="number"||(o=o||[]).push(c,""+u):c!=="suppressContentEditableWarning"&&c!=="suppressHydrationWarning"&&(ur.hasOwnProperty(c)?(u!=null&&c==="onScroll"&&te("scroll",e),o||l===u||(o=[])):(o=o||[]).push(c,u))}a&&(o=o||[]).push("style",a);var c=o;if(t.updateQueue=c)t.flags|=4}};xc=function(e,t,a,n){a!==n&&(t.flags|=4)};m0=typeof WeakSet==="function"?WeakSet:Set;x0=Math.ceil,ss=qt.ReactCurrentDispatcher,Qu=qt.ReactCurrentOwner,tt=qt.ReactCurrentBatchConfig,sn=la(0);Ac=function(e,t,a){if(e!==null)if(e.memoizedProps!==t.pendingProps||qe.current)Ue=!0;else{if((e.lanes&a)===0&&(t.flags&128)===0)return Ue=!1,f0(e,t,a);Ue=(e.flags&131072)!==0?!0:!1}else Ue=!1,ne&&(t.flags&1048576)!==0&&zf(t,Jo,t.index);switch(t.lanes=0,t.tag){case 2:var n=t.type;_o(e,t),e=t.pendingProps;var r=hn(t,ze.current);cn(t,a),r=ju(null,t,n,e,r,a);var o=Ku();return t.flags|=1,typeof r==="object"&&r!==null&&typeof r.render==="function"&&r.$$typeof===void 0?(t.tag=1,t.memoizedState=null,t.updateQueue=null,He(n)?(o=!0,Qo(t)):o=!1,t.memoizedState=r.state!==null&&r.state!==void 0?r.state:null,qu(t),r.updater=xs,t.stateNode=r,r._reactInternals=t,tu(t,n,e,a),t=ru(null,t,n,!0,o,a)):(t.tag=0,ne&&o&&Du(t),Ee(null,t,r,a),t=t.child),t;case 16:n=t.elementType;e:{switch(_o(e,t),e=t.pendingProps,r=n._init,n=r(n._payload),t.type=n,r=t.tag=b0(n),e=ft(n,e),r){case 0:t=nu(null,t,n,e,a);break e;case 1:t=bd(null,t,n,e,a);break e;case 11:t=Sd(null,t,n,e,a);break e;case 14:t=Pd(null,t,n,ft(n.type,e),a);break e}throw Error(k(306,n,""))}return t;case 0:return n=t.type,r=t.pendingProps,r=t.elementType===n?r:ft(n,r),nu(e,t,n,r,a);case 1:return n=t.type,r=t.pendingProps,r=t.elementType===n?r:ft(n,r),bd(e,t,n,r,a);case 3:e:{if(cc(t),e===null)throw Error(k(387));n=t.pendingProps,o=t.memoizedState,r=o.element,Nf(e,t),as(t,n,null,a);var s=t.memoizedState;if(n=s.element,o.isDehydrated)if(o={element:n,isDehydrated:!1,cache:s.cache,pendingSuspenseBoundaries:s.pendingSuspenseBoundaries,transitions:s.transitions},t.updateQueue.baseState=o,t.memoizedState=o,t.flags&256){r=yn(Error(k(423)),t),t=Md(e,t,n,a,r);break e}else if(n!==r){r=yn(Error(k(424)),t),t=Md(e,t,n,a,r);break e}else for(je=Jt(t.stateNode.containerInfo.firstChild),Ke=t,ne=!0,pt=null,a=_f(t,null,n,a),t.child=a;a;)a.flags=a.flags&-3|4096,a=a.sibling;else{if(gn(),n===r){t=Ut(e,t,a);break e}Ee(e,t,n,a)}t=t.child}return t;case 5:return Uf(t),e===null&&Yl(t),n=t.type,r=t.pendingProps,o=e!==null?e.memoizedProps:null,s=r.children,Kl(n,r)?s=null:o!==null&&Kl(n,o)&&(t.flags|=32),fc(e,t),Ee(e,t,s,a),t.child;case 6:return e===null&&Yl(t),null;case 13:return pc(e,t,a);case 4:return Hu(t,t.stateNode.containerInfo),n=t.pendingProps,e===null?t.child=xn(t,null,n,a):Ee(e,t,n,a),t.child;case 11:return n=t.type,r=t.pendingProps,r=t.elementType===n?r:ft(n,r),Sd(e,t,n,r,a);case 7:return Ee(e,t,t.pendingProps,a),t.child;case 8:return Ee(e,t,t.pendingProps.children,a),t.child;case 12:return Ee(e,t,t.pendingProps.children,a),t.child;case 10:e:{if(n=t.type._context,r=t.pendingProps,o=t.memoizedProps,s=r.value,Y(es,n._currentValue),n._currentValue=s,o!==null)if(gt(o.value,s)){if(o.children===r.children&&!qe.current){t=Ut(e,t,a);break e}}else for(o=t.child,o!==null&&(o.return=t);o!==null;){var l=o.dependencies;if(l!==null){s=o.child;for(var u=l.firstContext;u!==null;){if(u.context===n){if(o.tag===1){u=_t(-1,a&-a),u.tag=2;var c=o.updateQueue;if(c!==null){c=c.shared;var m=c.pending;m===null?u.next=u:(u.next=m.next,m.next=u),c.pending=u}}o.lanes|=a,u=o.alternate,u!==null&&(u.lanes|=a),Jl(o.return,a,t),l.lanes|=a;break}u=u.next}}else if(o.tag===10)s=o.type===t.type?null:o.child;else if(o.tag===18){if(s=o.return,s===null)throw Error(k(341));s.lanes|=a,l=s.alternate,l!==null&&(l.lanes|=a),Jl(s,a,t),s=o.sibling}else s=o.child;if(s!==null)s.return=o;else for(s=o;s!==null;){if(s===t){s=null;break}if(o=s.sibling,o!==null){o.return=s.return,s=o;break}s=s.return}o=s}Ee(e,t,r.children,a),t=t.child}return t;case 9:return r=t.type,n=t.pendingProps.children,cn(t,a),r=at(r),n=n(r),t.flags|=1,Ee(e,t,n,a),t.child;case 14:return n=t.type,r=ft(n,t.pendingProps),r=ft(n.type,r),Pd(e,t,n,r,a);case 15:return ic(e,t,t.type,t.pendingProps,a);case 17:return n=t.type,r=t.pendingProps,r=t.elementType===n?r:ft(n,r),_o(e,t),t.tag=1,He(n)?(e=!0,Qo(t)):e=!1,cn(t,a),sc(t,n,r),tu(t,n,r,a),ru(null,t,n,!0,e,a);case 19:return mc(e,t,a);case 22:return dc(e,t,a)}throw Error(k(156,t.tag))};Dc=typeof reportError==="function"?reportError:function(e){console.error(e)};Is.prototype.render=ri.prototype.render=function(e){var t=this._internalRoot;if(t===null)throw Error(k(409));zc(e,t,null,null)};Is.prototype.unmount=ri.prototype.unmount=function(){var e=this._internalRoot;if(e!==null){this._internalRoot=null;var t=e.containerInfo;vs(function(){zc(null,e,null,null)}),t[kn]=null}};Is.prototype.unstable_scheduleHydration=function(e){if(e){var t=df();e={blockedOn:null,target:e,priority:t};for(var a=0;a<jt.length&&t!==0&&t<jt[a].priority;a++);jt.splice(a,0,e),a===0&&cf(e)}};lf=function(e){switch(e.tag){case 3:var t=e.stateNode;if(t.current.memoizedState.isDehydrated){var a=jn(t.pendingLanes);a!==0&&(Cu(t,a|1),We(t,me()),(H&6)===0&&(vn=me()+500,ua()))}break;case 13:vs(function(){var n=Nt(e,1);if(n!==null){var r=_e();ht(n,e,1,r)}}),ni(e,1)}};Su=function(e){if(e.tag===13){var t=Nt(e,134217728);if(t!==null){var a=_e();ht(t,e,134217728,a)}ni(e,134217728)}};uf=function(e){if(e.tag===13){var t=aa(e),a=Nt(e,t);if(a!==null){var n=_e();ht(a,e,t,n)}ni(e,t)}};df=function(){return K};ff=function(e,t){var a=K;try{return K=e,t()}finally{K=a}};Bl=function(e,t,a){switch(t){case"input":if(Ml(e,a),t=a.name,a.type==="radio"&&t!=null){for(a=e;a.parentNode;)a=a.parentNode;a=a.querySelectorAll("input[name="+JSON.stringify(""+t)+'][type="radio"]');for(t=0;t<a.length;t++){var n=a[t];if(n!==e&&n.form===e.form){var r=zu(n);if(!r)throw Error(k(90));Vd(n),Ml(n,r)}}}break;case"textarea":jd(e,a);break;case"select":t=a.value,t!=null&&ln(e,!!a.multiple,t,!1)}};Qd=y0;Yd=vs;Hn={findFiberByHostInstance:Ca,bundleType:0,version:"18.3.1",rendererPackageName:"react-dom"},R0={bundleType:Hn.bundleType,version:Hn.version,rendererPackageName:Hn.rendererPackageName,rendererConfig:Hn.rendererConfig,overrideHookState:null,overrideHookStateDeletePath:null,overrideHookStateRenamePath:null,overrideProps:null,overridePropsDeletePath:null,overridePropsRenamePath:null,setErrorHandler:null,setSuspenseHandler:null,scheduleUpdate:null,currentDispatcherRef:qt.ReactCurrentDispatcher,findHostInstanceByFiber:function(e){return e=jm(e),e===null?null:e.stateNode},findFiberByHostInstance:Hn.findFiberByHostInstance||T0,findHostInstancesForRefresh:null,scheduleRefresh:null,scheduleRoot:null,setRefreshHandler:null,getCurrentFiber:null,reconcilerVersion:"18.3.1-next-f1338f8080-20240426"};if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__<"u"){if(Za=__REACT_DEVTOOLS_GLOBAL_HOOK__,!Za.isDisabled&&Za.supportsFiber)try{ds=Za.inject(R0),Mt=Za}catch(e){}}});function _c(){if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__>"u"||typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE!=="function")return;try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(_c)}catch(e){console.error(e)}}var li=Hs(()=>{Ec();_c()});var Oc=Ii(function(D0){li();D0.createRoot=oi,D0.hydrateRoot=si;var z0});var Up=wi(Oc(),1);var Nc=document.createElement("style");Nc.textContent=`/* The dotz look: the site's own tokens (style.css :root, light and dark)
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
  --ss-success: var(--ok);
  --ss-success-soft: color-mix(in srgb, var(--ok) 14%, transparent);
  --ss-success-text: var(--ok);
  --ss-font: var(--font-sans);
  --ss-mono: var(--font-mono);
  --ss-radius-sm: 6px;
  --ss-radius-md: var(--radius-sm);
  --ss-radius-lg: var(--radius-md);
  --ss-radius-window: var(--radius-lg);
  --ss-shadow-hero: 0 0 0 1px var(--line), var(--float);
  --ss-shadow-satellite: 0 0 0 1px var(--line), var(--float);
  --ss-shadow-ground: none;
  color: var(--ink);
  word-break: keep-all;
  overflow-wrap: break-word;
}

/* A phrase that never breaks inside (Netflix-subtitle line breaks) */
.dz .ph { display: inline-block; }

/* The app's own buttons: 보내기 accent, 고치기 tonal, 보내지 않기 text */
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
  transition: background-color var(--m-base) var(--m-ease), color var(--m-base) var(--m-ease), opacity var(--m-slow) var(--m-ease), transform 0.12s ease;
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
  transition: opacity var(--m-base) var(--m-ease), filter var(--m-base) var(--m-ease);
}
.dz-layer[data-on] { opacity: 1; filter: none; transition-delay: 0.06s; }
.dz-btn--send .ss-check__ring { stroke: color-mix(in srgb, var(--btn-ink) 40%, transparent); }
.dz-btn--send .ss-check__arc { stroke: var(--btn-ink); }

/* The draft card's actions and its sent line share one cell, so nothing
   below moves when it turns to 보냈어요 */
.dz-acts-cell { display: grid; grid-template-areas: 'stack'; }
.dz-acts-cell > * { grid-area: stack; transition: opacity var(--m-slow) var(--m-ease), filter var(--m-slow) var(--m-ease); }
.dz-acts-cell > [data-off] { opacity: 0; filter: blur(2px); pointer-events: none; }
.dz-acts { display: flex; align-items: center; gap: 8px; }
.dz-sent {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  color: var(--ok);
  font-size: 13px;
  font-weight: 600;
}
.dz-sent .dz-sent__time { color: var(--muted); font-weight: 400; }
.dz-sent .ss-check__fill { fill: var(--ok); }
.dz-sent .ss-check__tick { stroke: var(--surface); }

/* Small status tags (the product's .tag): a tint of the status colour; two can share one cell and swap in place */
.dz-tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--body);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  white-space: nowrap;
}
.dz-tag--pri { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent-ink); }
.dz-tag--ok { background: color-mix(in srgb, var(--ok) 14%, transparent); color: var(--ok); }
.dz-tag--warn { background: color-mix(in srgb, var(--warn) 14%, transparent); color: var(--warn); }
.dz-swap { display: inline-grid; grid-template-areas: 'stack'; }
.dz-swap > * { grid-area: stack; justify-self: end; transition: opacity var(--m-base) var(--m-ease), transform var(--m-base) var(--m-ease); }
.dz-swap > [data-off] { opacity: 0; transform: scale(0.985); }
`;document.head.appendChild(Nc);ut();var Uc=(e)=>e.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase(),Cs=(...e)=>e.filter((t,a,n)=>Boolean(t)&&t.trim()!==""&&n.indexOf(t)===a).join(" ").trim();ut();var qc={xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};var Hc=Rn(({color:e="currentColor",size:t=24,strokeWidth:a=2,absoluteStrokeWidth:n,className:r="",children:o,iconNode:s,...l},u)=>ja("svg",{ref:u,...qc,width:t,height:t,stroke:e,strokeWidth:n?Number(a)*24/Number(t):a,className:Cs("lucide",r),...l},[...s.map(([c,m])=>ja(c,m)),...Array.isArray(o)?o:[o]]));var F=(e,t)=>{let a=Rn(({className:n,...r},o)=>ja(Hc,{ref:o,iconNode:t,className:Cs(`lucide-${Uc(e)}`,n),...r}));return a.displayName=`${e}`,a};var ia=F("Ellipsis",[["circle",{cx:"12",cy:"12",r:"1",key:"41hilf"}],["circle",{cx:"19",cy:"12",r:"1",key:"1wjl8i"}],["circle",{cx:"5",cy:"12",r:"1",key:"1pcz8c"}]]);var da=F("House",[["path",{d:"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8",key:"5wwlr5"}],["path",{d:"M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",key:"1d0kgt"}]]);var br=F("Archive",[["rect",{width:"20",height:"5",x:"2",y:"3",rx:"1",key:"1wp1u1"}],["path",{d:"M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8",key:"1s80jp"}],["path",{d:"M10 12h4",key:"a56b0p"}]]);var Mr=F("ArrowRight",[["path",{d:"M5 12h14",key:"1ays0h"}],["path",{d:"m12 5 7 7-7 7",key:"xquz4c"}]]);var Ar=F("ArrowUpRight",[["path",{d:"M7 7h10v10",key:"1tivn9"}],["path",{d:"M7 17 17 7",key:"1vkiza"}]]);var Tr=F("ArrowUp",[["path",{d:"m5 12 7-7 7 7",key:"hav0vg"}],["path",{d:"M12 19V5",key:"x0mq9r"}]]);var Ba=F("Bell",[["path",{d:"M10.268 21a2 2 0 0 0 3.464 0",key:"vwvbt9"}],["path",{d:"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",key:"11g9vi"}]]);var Rr=F("Calendar",[["path",{d:"M8 2v4",key:"1cmpym"}],["path",{d:"M16 2v4",key:"4m81vk"}],["rect",{width:"18",height:"18",x:"3",y:"4",rx:"2",key:"1hopcy"}],["path",{d:"M3 10h18",key:"8toen8"}]]);var Fr=F("Check",[["path",{d:"M20 6 9 17l-5-5",key:"1gmf2c"}]]);var zr=F("ChevronDown",[["path",{d:"m6 9 6 6 6-6",key:"qrunsl"}]]);var Dr=F("ChevronLeft",[["path",{d:"m15 18-6-6 6-6",key:"1wnfg3"}]]);var Br=F("ChevronRight",[["path",{d:"m9 18 6-6-6-6",key:"mthhwq"}]]);var Er=F("Clock",[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["polyline",{points:"12 6 12 12 16 14",key:"68esgv"}]]);var _r=F("CreditCard",[["rect",{width:"20",height:"14",x:"2",y:"5",rx:"2",key:"ynyp8z"}],["line",{x1:"2",x2:"22",y1:"10",y2:"10",key:"1b3vmo"}]]);var Or=F("File",[["path",{d:"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",key:"1rqfz7"}],["path",{d:"M14 2v4a2 2 0 0 0 2 2h4",key:"tnqrlb"}]]);var Nr=F("Globe",[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["path",{d:"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",key:"13o1zl"}],["path",{d:"M2 12h20",key:"9i4pu4"}]]);var Ur=F("GripVertical",[["circle",{cx:"9",cy:"12",r:"1",key:"1vctgf"}],["circle",{cx:"9",cy:"5",r:"1",key:"hp0tcf"}],["circle",{cx:"9",cy:"19",r:"1",key:"fkjjf6"}],["circle",{cx:"15",cy:"12",r:"1",key:"1tmaij"}],["circle",{cx:"15",cy:"5",r:"1",key:"19l28e"}],["circle",{cx:"15",cy:"19",r:"1",key:"f4zoj3"}]]);var qr=F("Heart",[["path",{d:"M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",key:"c3ymky"}]]);var Hr=F("Lock",[["rect",{width:"18",height:"11",x:"3",y:"11",rx:"2",ry:"2",key:"1w4ew1"}],["path",{d:"M7 11V7a5 5 0 0 1 10 0v4",key:"fwvmzm"}]]);var Wr=F("Mail",[["rect",{width:"20",height:"16",x:"2",y:"4",rx:"2",key:"18n3k1"}],["path",{d:"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7",key:"1ocrg3"}]]);var Vr=F("Pause",[["rect",{x:"14",y:"4",width:"4",height:"16",rx:"1",key:"zuxfzm"}],["rect",{x:"6",y:"4",width:"4",height:"16",rx:"1",key:"1okwgv"}]]);var Gr=F("Play",[["polygon",{points:"6 3 20 12 6 21 6 3",key:"1oa8hb"}]]);var Ea=F("Plus",[["path",{d:"M5 12h14",key:"1ays0h"}],["path",{d:"M12 5v14",key:"s699le"}]]);var jr=F("ScanFace",[["path",{d:"M3 7V5a2 2 0 0 1 2-2h2",key:"aa7l1z"}],["path",{d:"M17 3h2a2 2 0 0 1 2 2v2",key:"4qcy5o"}],["path",{d:"M21 17v2a2 2 0 0 1-2 2h-2",key:"6vwrx8"}],["path",{d:"M7 21H5a2 2 0 0 1-2-2v-2",key:"ioqczr"}],["path",{d:"M8 14s1.5 2 4 2 4-2 4-2",key:"1y1vjs"}],["path",{d:"M9 9h.01",key:"1q5me6"}],["path",{d:"M15 9h.01",key:"x1ddxp"}]]);var _a=F("Search",[["circle",{cx:"11",cy:"11",r:"8",key:"4ej97u"}],["path",{d:"m21 21-4.3-4.3",key:"1qie3q"}]]);var Kr=F("Send",[["path",{d:"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",key:"1ffxy3"}],["path",{d:"m21.854 2.147-10.94 10.939",key:"12cjpa"}]]);var Xr=F("Settings",[["path",{d:"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",key:"1qme2f"}],["circle",{cx:"12",cy:"12",r:"3",key:"1v7zrd"}]]);var $r=F("Star",[["path",{d:"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",key:"r04s7s"}]]);var Zr=F("Trash2",[["path",{d:"M3 6h18",key:"d0wm0j"}],["path",{d:"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6",key:"4alrt4"}],["path",{d:"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2",key:"v07s0e"}],["line",{x1:"10",x2:"10",y1:"11",y2:"17",key:"1uufr5"}],["line",{x1:"14",x2:"14",y1:"11",y2:"17",key:"xtxkd"}]]);var Qr=F("User",[["path",{d:"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2",key:"975kel"}],["circle",{cx:"12",cy:"7",r:"4",key:"17ys0d"}]]);var Yr=F("Wifi",[["path",{d:"M12 20h.01",key:"zekei9"}],["path",{d:"M2 8.82a15 15 0 0 1 20 0",key:"dnpr2z"}],["path",{d:"M5 12.859a10 10 0 0 1 14 0",key:"1x1e6c"}],["path",{d:"M8.5 16.429a5 5 0 0 1 7 0",key:"1bycff"}]]);var Jr=F("X",[["path",{d:"M18 6 6 18",key:"1bl5f8"}],["path",{d:"m6 6 12 12",key:"d8bk6v"}]]);var eo=F("Zap",[["path",{d:"M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z",key:"1xq2db"}]]);ut();var Wc=document.createElement("style");Wc.textContent=`/* Stageshow kit: the stage. Tokens, the looks (theme, palette,
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
`;document.head.appendChild(Wc);li();var Vc=document.createElement("style");Vc.textContent=`/* Keystrokes (act.key): the keycap rows. */

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
`;document.head.appendChild(Vc);ut();var B0=Symbol.for("react.element"),E0=Symbol.for("react.fragment"),_0=Object.prototype.hasOwnProperty,O0=An.ReactCurrentOwner,N0={key:!0,ref:!0,__self:!0,__source:!0};function Gc(e,t,a){var n,r={},o=null,s=null;a!==void 0&&(o=""+a),t.key!==void 0&&(o=""+t.key),t.ref!==void 0&&(s=t.ref);for(n in t)_0.call(t,n)&&!N0.hasOwnProperty(n)&&(r[n]=t[n]);if(e&&e.defaultProps)for(n in t=e.defaultProps,t)r[n]===void 0&&(r[n]=t[n]);return{$$typeof:B0,type:e,key:o,ref:s,props:r,_owner:O0.current}}var Oa=E0,f=Gc,A=Gc;var U0={cmd:"⌘",shift:"⇧",alt:"⌥",option:"⌥",ctrl:"⌃",enter:"↵",return:"↵",esc:"esc",tab:"⇥",up:"↑",down:"↓",left:"←",right:"→",backspace:"⌫"},jc=(e)=>e.split("+").map((t)=>U0[t.trim().toLowerCase()]??t.trim().toUpperCase());function Kc({rows:e,at:t}){return f(Oa,{children:e.map((a)=>a&&f("div",{className:"ss-keys","data-show":a.show,"data-at":t,"aria-hidden":!0,children:a.caps.map((n,r)=>f("kbd",{className:"ss-key","data-down":a.down,children:n},r))},a.id))})}var Ss={x:0,y:0,width:0,height:0},Ps=(e)=>typeof e==="string"?e:("at"in e)?e.at:null;var Xc=(e,t)=>e?.offsetWidth&&e.getBoundingClientRect().width/e.offsetWidth||t||1;function bs(e,t){let a=e.getBoundingClientRect();return{left:a.left,top:a.top,scale:e.offsetWidth&&a.width/e.offsetWidth||t||1,borderX:e.clientLeft,borderY:e.clientTop}}function Na(e,t,a,n=bs(e,a)){let r=t.getBoundingClientRect(),{scale:o}=n;return{x:(r.left-n.left)/o-n.borderX,y:(r.top-n.top)/o-n.borderY,width:r.width/o,height:r.height/o}}function $c(e,t,a,n=bs(e,a)){let r=Na(e,t,a,n),o=getComputedStyle(t),s=o.transform,l=s&&s!=="none"?s.match(/^matrix\(([^)]+)\)$/):null;if(!l)return r;let[u,c,m,g,h,L]=l[1].split(",").map(Number);if(c||m||h||L||!u||!g)return r;let x=r.width/u,C=r.height/g,[E,d]=o.transformOrigin.split(" ").map(parseFloat);return{x:r.x-E*(1-u),y:r.y-d*(1-g),width:x,height:C}}var q0=(e)=>{let t=getComputedStyle(e);return t.transform!=="none"||t.translate&&t.translate!=="none"||t.scale&&t.scale!=="none"||t.rotate&&t.rotate!=="none"};function Zc(e,t){let a=!0;for(let s=t;s&&s!==e;s=s.parentElement)if(q0(s)){a=!1;break}if(a)return Na(e,t,1);let n=0,r=0,o=t;while(o&&o!==e){n+=o.offsetLeft,r+=o.offsetTop;let s=o.offsetParent;if(!s||!e.contains(s))break;if(o=s,o!==e)n+=o.clientLeft-o.scrollLeft,r+=o.clientTop-o.scrollTop}return{x:n,y:r,width:t.offsetWidth,height:t.offsetHeight}}function ui(e,t){let a=Object.keys(e);if(a.length!==Object.keys(t).length)return!1;return a.every((n)=>{let r=e[n],o=t[n];return o&&Math.abs(r.x-o.x)<0.5&&Math.abs(r.y-o.y)<0.5&&Math.abs(r.width-o.width)<0.5&&Math.abs(r.height-o.height)<0.5})}function Ms(e){let t=e.parentElement;if(!t?.classList.contains("ss-scroller"))return;let{clientHeight:a,scrollHeight:n}=e,r=n>a?Math.max(24,a/n*a):0,o=n>a?e.scrollTop/(n-a)*(a-r):0;t.style.setProperty("--ss-thumb-h",`${r}px`),t.style.setProperty("--ss-thumb-y",`${o}px`)}var H0={house:[0.65,0,0.1,1],through:[0.8,0,0.1,1],settle:[0.05,0.85,0.3,1],enter:[0.1,0.8,0.3,0.95],trip:[0.78,0,0.17,1],camera:[0.45,0,0.1,1]};function Qc(e){let[t,a,n,r]=typeof e==="string"?H0[e]:e,o=3*t,s=3*(n-t)-o,l=1-o-s,u=3*a,c=3*(r-a)-u,m=1-u-c,g=(L)=>((l*L+s)*L+o)*L,h=(L)=>(3*l*L+2*s)*L+o;return(L)=>{if(L<=0)return 0;if(L>=1)return 1;let x=L;for(let C=0;C<8;C++){let E=h(x);if(Math.abs(E)<0.000001)break;let d=x-(g(x)-L)/E;if(d<0||d>1)break;x=d}if(Math.abs(g(x)-L)>0.000001){let C=0,E=1;for(let d=0;d<40;d++)if(x=(C+E)/2,g(x)<L)C=x;else E=x}return((m*x+c)*x+u)*x}}function ii(){try{return!1}catch{return!0}}function fa(e){if(ii())console.warn(`[stageshow] ${e}`)}var ca=(e,t,a)=>Math.min(a,Math.max(t,e)),Cn=(e)=>e<0.5?4*e*e*e:1-Math.pow(-2*e+2,3)/2,Yc=(e)=>{let t=Math.sin(e*12.9898)*43758.5453;return t-Math.floor(t)};var Jc=(e)=>{if(!e)return;window.setTimeout(()=>e.removeAttribute("data-touching"),240)};class pa extends Error{}function ep(e,t){let{rootRef:a,cursorRef:n,pos:r,hovered:o,kindRef:s,keysRef:l,dragging:u,autoUsed:c,autoRef:m,scaleRef:g,speed:h,layout:L,cursor:x,resolve:C,place:E,remeasure:d,ripple:i,setState:p,setKind:v,setKeys:w,setLastKeys:z}=t,D=Qc("enter"),y=()=>{if(e.aborted)throw new pa},Q=(b,S)=>new Promise((I,P)=>{y();let M=()=>{S(N),e.removeEventListener("abort",M),P(new pa)},N=b(()=>{if(e.removeEventListener("abort",M),e.aborted)P(new pa);else I()});e.addEventListener("abort",M,{once:!0})}),B=()=>Q((b)=>requestAnimationFrame(b),cancelAnimationFrame),V=(b)=>Q((S)=>setTimeout(S,b/h),clearTimeout),rt=(b)=>{let S=!0,I=()=>{if(!S)return;S=!1,e.removeEventListener("abort",I),b()};return e.addEventListener("abort",I,{once:!0}),I},De=async(b,S)=>{let I=performance.now(),P=b/h;for(;;){y();let M=Math.min(1,(performance.now()-I)/P);if(S(M),M===1)return;await B()}},ye=(b)=>{let S=[];for(let I=b;I&&I!==a.current;I=I.parentElement)if(I.hasAttribute("data-target"))S.push(I);return S},Lt=(b)=>{let S=a.current;if(!S)return;let I=S.querySelectorAll("[data-cursor]");if(!I.length&&!c.current)return;if(I.length)c.current=!0;let P=S.getBoundingClientRect(),M=P.width/S.offsetWidth||1,N=S.dataset.cursorBase??"pointer",X=N;S.setAttribute("data-hit","");let ue=document.elementsFromPoint(P.left+b.x*M,P.top+b.y*M);S.removeAttribute("data-hit");let _=ue.find((O)=>{if(!S.contains(O)||O.closest(".ss-cursor, .ss-keys, .ss-ripple"))return!1;if(getComputedStyle(O).pointerEvents==="none"&&!O.closest('[data-cursor], [data-target], button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="tab"]'))return!1;let ie=1;for(let j=O;j&&j!==S.parentElement;j=j.parentElement){let fe=getComputedStyle(j);if(fe.visibility==="hidden")return!1;ie*=Number(fe.opacity)}return ie>0.15});if(_){let O=_.closest('[data-cursor], button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="tab"]');if(X=O&&S.contains(O)&&O.dataset.cursor?O.dataset.cursor:N,X!==s.current)v(X);return}if(I.forEach((O)=>{let ie=O.getBoundingClientRect(),j=(ie.left-P.left)/M,fe=(ie.top-P.top)/M;if(b.x>=j&&b.x<=j+ie.width/M&&b.y>=fe&&b.y<=fe+ie.height/M)X=O.dataset.cursor}),X!==s.current)v(X)};if(m.current=Lt,!u.current)Lt(r.current);let Ve=(b)=>{if(o.current===b)return;let S=ye(b);ye(o.current).forEach((I)=>S.includes(I)||I.removeAttribute("data-hover")),S.forEach((I)=>I.setAttribute("data-hover","")),o.current=b},ve=l.current.id,$e=0,ot=(b)=>{let S=Ps(b);return S===null?null:a.current?.querySelector(`[data-target="${S}"]`)??null},ke={get signal(){return e},put(b){if(!e.aborted)p((S)=>({...S,...typeof b==="function"?b(S):b}))},async set(b){y(),ke.put(b),await B(),await B(),m.current?.(r.current),y()},wait:async(b)=>{y(),await V(b)},rect:(b,S)=>{let I=a.current,P=I?.querySelector(`[data-target="${b}"]`);if(!I||!P)return fa(`no element with data-target="${b}"`),Ss;return S?.layout?Zc(I,P):Na(I,P,g.current)},center:(b)=>C(b),caret(b,S){$e++;let I=ot(b),P=a.current;if(!I||!P)return 0;let M=P.getBoundingClientRect(),N=M.width/P.offsetWidth||1,X=M.left+S.x*N,ue=M.top+S.y*N,_=[],O=document.createTreeWalker(I,NodeFilter.SHOW_TEXT),ie=document.createRange(),j=0,fe=(G)=>{for(let Se=G.parentElement;Se;Se=Se===I?null:Se.parentElement){let J=getComputedStyle(Se);if(J.opacity==="0"||J.visibility==="hidden"||J.display==="none")return!0}return!1};for(let G=O.nextNode();G;G=O.nextNode()){let Se=G.textContent??"";if(fe(G))continue;for(let J=0;J<Se.length;J++){ie.setStart(G,J),ie.setEnd(G,J+1);let he=ie.getBoundingClientRect();if(he.width||he.height)_.push({left:he.left,right:he.right,mid:(he.left+he.right)/2,top:he.top,bottom:he.bottom,at:j+J})}j+=Se.length}if(!_.length)return 0;if(ue<_[0].top)return 0;if(ue>_[_.length-1].bottom)return j;let Be=_[0];for(let G of _)if(Math.abs((G.top+G.bottom)/2-ue)<Math.abs((Be.top+Be.bottom)/2-ue))Be=G;let Ce=_.filter((G)=>Math.abs(G.top-Be.top)<(Be.bottom-Be.top)/2),Ua=Ce.find((G)=>G.mid>X);return Ua?Ua.at:Ce[Ce.length-1].at+1},async move(b,S){y();let I={...r.current},P=C(b),M=Math.hypot(P.x-I.x,P.y-I.y);if(M<0.5)return Ve(ot(b));let N=ye(ot(b));Ve(ye(o.current).find((j)=>N.includes(j))??null);let X=S?.duration??ca(260+M*0.9,300,650),ue=Cn,_=Math.min(M*0.08,24),O=-(P.y-I.y)/M,ie=(P.x-I.x)/M;await De(X,(j)=>{let fe=ue(j),Be=Math.sin(Math.PI*fe)*_,Ce=S?.path?S.path(fe,I,P):{x:I.x+(P.x-I.x)*fe+O*Be,y:I.y+(P.y-I.y)*fe+ie*Be};if(E(Ce),Lt(Ce),S?.onMove)ks(()=>S.onMove(Ce,I,j))}),y(),Ve(ot(b))},async click(b,S){if(y(),b!==void 0)await ke.move(b),await V(120);y();let I=b!==void 0?ot(b):o.current,P=n.current,M=x?.style==="touch",N=rt(()=>{if(P?.removeAttribute("data-pressed"),I?.removeAttribute("data-pressed"),M)Jc(P)});try{if(M)P?.setAttribute("data-touching",""),await V(140),y();for(let X=0;X<(S?.double?2:1);X++){if(X)await V(70);if(y(),P?.setAttribute("data-pressed","true"),x?.ripple)i(r.current);I?.setAttribute("data-pressed",S?.right?"right":""),await V(S?.double?80:100),y(),P?.removeAttribute("data-pressed"),I?.removeAttribute("data-pressed")}}finally{N()}},async scroll(b,S,I){y();let P=ot(b);if(!P)return;let M=P.scrollTop,N=typeof S==="number"?S:M;if(typeof S==="string"){let _=ot(S);if(_)N=M+(_.getBoundingClientRect().top-P.getBoundingClientRect().top)/Xc(a.current,g.current)-(I?.offset??0)}if(N=ca(N,0,P.scrollHeight-P.clientHeight),x){let _=Na(a.current,P,g.current||1),O=r.current;if(!(O.x>=_.x+8&&O.x<=_.x+_.width-8&&O.y>=_.y+8&&O.y<=_.y+_.height-8))await this.move({x:_.x+_.width*0.6,y:_.y+_.height*0.55}),await this.wait(120)}let X=P.parentElement?.classList.contains("ss-scroller")?P.parentElement:null;X?.setAttribute("data-scrolling","");let ue=rt(()=>X?.removeAttribute("data-scrolling"));try{await De(I?.duration??ca(420+Math.abs(N-M)*1.2,500,1400),(_)=>{P.scrollTop=M+(N-M)*Cn(_),P.toggleAttribute("data-scrolled",P.scrollTop>0.5),Ms(P)}),y()}finally{ue()}d(),m.current?.(r.current)},async snap(b,S){y();let I=S?a.current?.querySelector(`[data-target="${S}"]`):a.current;I?.setAttribute("data-instant","");let P=rt(()=>I?.removeAttribute("data-instant"));try{ke.put(b),await B(),await B(),y()}finally{P()}},async key(b){y();let S=jc(b),I=++ve,P=l.current;z(P.caps.length?{...P,show:!1,down:!1}:null),w({id:I,caps:S,show:!1,down:!1}),await B(),await B(),y(),w({id:I,caps:S,show:!0,down:!1}),await V(180),y(),w({id:I,caps:S,show:!0,down:!0}),await V(140),y(),w({id:I,caps:S,show:!0,down:!1}),V(600).then(()=>{if(ve===I&&!e.aborted)w({id:I,caps:S,show:!1,down:!1})},(M)=>{if(!(M instanceof pa))console.error("[stageshow] script error",M)})},async stagger(b,S,I=60){await Promise.all(b.map(async(P,M)=>{if(M)await V(I*M);y(),await S(P,M)}))},mark(b){if(!e.aborted)a.current?.setAttribute("data-mark",b)},async cursor(b){y(),v(b),await B()},async type(b,S,I){let P=I?.interval??35;for(let M=0;M<=S.length;M++)y(),p((N)=>({...N,[b]:S.slice(0,M)})),await V(P*(0.7+0.6*Yc(M)))},place(b){if(e.aborted)return;let S=C(b);E(S),m.current?.(S)},async enter(b,S){y();let I=C(b),P=a.current,M={x:0,y:0,w:P.offsetWidth,h:P.offsetHeight},N=40,X=[I.x-M.x,M.x+M.w-I.x,I.y-M.y,M.y+M.h-I.y],ue=X.indexOf(Math.min(...X)),_=ue===0?{x:M.x-N,y:I.y+M.h*0.12}:ue===1?{x:M.x+M.w+N*0.4,y:I.y+M.h*0.12}:ue===2?{x:I.x-M.w*0.06,y:M.y-N}:{x:I.x+M.w*0.06,y:M.y+M.h+N*0.4};E(_),Ve(null),await De(S?.duration??700,(O)=>{let ie=D(O),j={x:_.x+(I.x-_.x)*ie,y:_.y+(I.y-_.y)*ie};E(j),Lt(j)}),y(),Ve(ot(b))},async drag(b,S,I){y();let P={...r.current},M=C(b),N=Math.hypot(M.x-P.x,M.y-P.y);Ve(null);let X=s.current,ue=X==="ibeam"||X==="crosshair",_=!ue&&I?.cursor!=="preserve",O=x?.style==="touch",ie=(G)=>G<0.25?G*G/0.5*1.1428571428571428:(G-0.125)*1.1428571428571428;if(O)n.current?.setAttribute("data-touching",""),await V(140),y();let j=O?n.current?.querySelector(".ss-cursor__streak")??null:null,fe=[],Be=(G)=>{if(fe.unshift({...G}),fe.length>9)fe.pop();let Se=fe[fe.length-1],J=G.x-Se.x,he=G.y-Se.y,qa=Math.min(Math.hypot(J,he),100);if(!j)return;j.style.width=`${qa}px`,j.style.left=`${-qa}px`,j.style.transform=`rotate(${Math.atan2(he,J)}rad)`};u.current=!0;let Ce=n.current,Ua=rt(()=>{if(u.current=!1,Ce?.removeAttribute("data-pressed"),Ce?.removeAttribute("data-swiping"),O)Jc(Ce)});try{if(Ce?.setAttribute("data-pressed","true"),await V(O?170:60),O){if(j)j.style.width="0px";Ce?.setAttribute("data-swiping","")}if(y(),_&&!O)v("grab");if(!O)await V(70);y(),Ce?.removeAttribute("data-pressed");let G=ue?0:Math.min(N*0.06,18),Se=N?-(M.y-P.y)/N:0,J=N?(M.x-P.x)/N:0,he=ue&&Math.abs(M.y-P.y)>6;if(he&&M.y>P.y&&M.x<P.x-2)fa("a text selection that ends left of where it starts overshoots and shrinks back; select text that starts a line, or fits on one");let qa=$e;if(await De(O?I?.duration??ca(180+N*0.5,240,300):I?.duration??ca(360+N*1.1,450,900),(Sn)=>{let yt=O?ie(Sn):Cn(Sn),Ha=Math.sin(Math.PI*yt)*G,ao=he?1-(1-yt)*(1-yt):yt,no=he?yt*yt:yt,Wa=I?.path?.(yt,P,M)??{x:P.x+(M.x-P.x)*no+Se*Ha,y:P.y+(M.y-P.y)*ao+J*Ha};if(ks(()=>S?.(Wa,P,Sn)),E(Wa),O)Be(Wa)}),ue&&S&&$e===qa)fa("selection drift: a text selection drag never read a.caret(), so the highlight is not under the I-beam; set it from a.caret(name, at) in onMove");if(y(),_&&!O)v(X==="grab"?"pointer":X)}finally{Ua()}m.current?.(M)},layout:L};for(let b of Object.keys(ke)){let S=ke[b];if(typeof S!=="function")continue;ke[b]=(...I)=>{let P=S.apply(ke,I);if(P instanceof Promise)P.catch((M)=>{if(!(M instanceof pa))console.error("[stageshow] script error",M)});return P}}return ke}function tp(e,t,a,n){let r=Object.keys(t).filter((o)=>JSON.stringify(e[o])!==JSON.stringify(t[o]));if(r.length)fa(`loop seam: state still differs from initial at the end of the script (${r.join(", ")})`);if(n&&Math.hypot(a.x-n.x,a.y-n.y)>1)fa("loop seam: cursor does not end where it starts")}function np(){return f("svg",{height:"24",width:"24",viewBox:"0 0 32 32",fill:"none",children:A("g",{transform:"translate(10 7)",children:[f("path",{d:"m6.148 18.473 1.863-1.003 1.615-.839-2.568-4.816h4.332l-11.379-11.408v16.015l3.316-3.221z",fill:"#fff"}),f("path",{d:"m6.431 17 1.765-.941-2.775-5.202h3.604l-8.025-8.043v11.188l2.53-2.442z",fill:"#000"})]})})}function rp(){return A("svg",{width:"10",height:"16",viewBox:"0 0 10 16",fill:"none",overflow:"visible",children:[f("path",{d:"M3 1H7M3 15H7M5 1V15",style:{stroke:"var(--ss-cursor-edge, #fff)"},strokeWidth:"2.6",strokeLinecap:"round"}),f("path",{d:"M3 1H7M3 15H7M5 1V15",style:{stroke:"var(--ss-cursor-line, #000)"},strokeWidth:"1",strokeLinecap:"round"})]})}function op(){return A("svg",{width:"17",height:"17",viewBox:"0 0 17 17",fill:"none",overflow:"visible",children:[f("path",{d:"M8.5 0V17M0 8.5H17",style:{stroke:"var(--ss-cursor-edge, #fff)"},strokeWidth:"2.6"}),f("path",{d:"M8.5 0V17M0 8.5H17",style:{stroke:"var(--ss-cursor-line, #000)"},strokeWidth:"1"})]})}function sp(){return A("svg",{width:"26",height:"26",viewBox:"0 0 32 32",fill:"none",children:[f("path",{d:"M10.6 6a1.7 1.7 0 0 1 3.4 0v6.6a1.3 1.3 0 0 1 2.6 0v.7a1.3 1.3 0 0 1 2.6 0v.7a1.3 1.3 0 0 1 2.6 0V19c0 3.1-2 5.6-5 5.6h-2.6c-2 0-3.3-.9-4.4-2.4l-3.1-4.1c-.6-.9-.4-2 .5-2.5.8-.4 1.7-.2 2.3.5l1.1 1.4V6Z",fill:"#fff",stroke:"#000",strokeWidth:"1.1",strokeLinejoin:"round"}),f("path",{d:"M14 12.6v3.6M16.6 13.3v3M19.2 14v2.6",stroke:"#000",strokeWidth:"1",strokeLinecap:"round"})]})}function lp(){return f("svg",{width:"26",height:"26",viewBox:"0 0 32 32",fill:"none",children:A("g",{transform:"translate(7 6)",children:[f("path",{d:"m4.5557 8.5742c-.098-.375-.196-.847-.406-1.552-.167-.557-.342-.859-.47-1.233-.155-.455-.303-.721-.496-1.181-.139-.329-.364-1.048-.457-1.44-.119-.509.033-.924.244-1.206.253-.339.962-.49 1.357-.351.371.13.744.512.916.788.288.46.357.632.717 1.542.393.992.564 1.918.611 2.231l.085.452c-.001-.04-.043-1.122-.044-1.162-.035-1.029-.06-1.823-.038-2.939.002-.126.064-.587.084-.715.078-.5.305-.8.673-.979.412-.201.926-.215 1.401-.017.423.173.626.55.687 1.022.014.109.094.987.093 1.107-.013 1.025.006 1.641.015 2.174.004.231.003 1.625.017 1.469.061-.656.094-3.189.344-3.942.144-.433.405-.746.794-.929.431-.203 1.113-.07 1.404.243.285.305.446.692.482 1.153.032.405-.019.897-.02 1.245 0 .867-.021 1.324-.037 2.121-.001.038-.015.298.023.182.094-.28.188-.542.266-.745.049-.125.241-.614.359-.859.114-.234.211-.369.415-.688.2-.313.415-.448.668-.561.54-.235 1.109.112 1.301.591.086.215.009.713-.028 1.105-.061.647-.254 1.306-.352 1.648-.128.447-.274 1.235-.34 1.601-.072.394-.234 1.382-.359 1.82-.086.301-.371.978-.652 1.384 0 0-1.074 1.25-1.192 1.812-.117.563-.078.567-.101.965-.024.399.121.923.121.923s-.802.104-1.234.034c-.391-.062-.875-.841-1-1.078-.172-.328-.539-.265-.682-.023-.225.383-.709 1.07-1.051 1.113-.668.084-2.054.03-3.139.02 0 0 .185-1.011-.227-1.358-.305-.26-.83-.784-1.144-1.06l-.832-.921c-.284-.36-.629-1.093-1.243-1.985-.348-.504-1.027-1.085-1.284-1.579-.223-.425-.331-.954-.19-1.325.225-.594.675-.897 1.362-.832.519.05.848.206 1.238.537.225.19.573.534.75.748.163.195.203.276.377.509.23.307.302.459.214.121",fill:"#fff"}),A("g",{stroke:"#000",strokeLinecap:"round",strokeWidth:".75",children:[f("path",{d:"m4.5557 8.5742c-.098-.375-.196-.847-.406-1.552-.167-.557-.342-.859-.47-1.233-.155-.455-.303-.721-.496-1.181-.139-.329-.364-1.048-.457-1.44-.119-.509.033-.924.244-1.206.253-.339.962-.49 1.357-.351.371.13.744.512.916.788.288.46.357.632.717 1.542.393.992.564 1.918.611 2.231l.085.452c-.001-.04-.043-1.122-.044-1.162-.035-1.029-.06-1.823-.038-2.939.002-.126.064-.587.084-.715.078-.5.305-.8.673-.979.412-.201.926-.215 1.401-.017.423.173.626.55.687 1.022.014.109.094.987.093 1.107-.013 1.025.006 1.641.015 2.174.004.231.003 1.625.017 1.469.061-.656.094-3.189.344-3.942.144-.433.405-.746.794-.929.431-.203 1.113-.07 1.404.243.285.305.446.692.482 1.153.032.405-.019.897-.02 1.245 0 .867-.021 1.324-.037 2.121-.001.038-.015.298.023.182.094-.28.188-.542.266-.745.049-.125.241-.614.359-.859.114-.234.211-.369.415-.688.2-.313.415-.448.668-.561.54-.235 1.109.112 1.301.591.086.215.009.713-.028 1.105-.061.647-.254 1.306-.352 1.648-.128.447-.274 1.235-.34 1.601-.072.394-.234 1.382-.359 1.82-.086.301-.371.978-.652 1.384 0 0-1.074 1.25-1.192 1.812-.117.563-.078.567-.101.965-.024.399.121.923.121.923s-.802.104-1.234.034c-.391-.062-.875-.841-1-1.078-.172-.328-.539-.265-.682-.023-.225.383-.709 1.07-1.051 1.113-.668.084-2.054.03-3.139.02 0 0 .185-1.011-.227-1.358-.305-.26-.83-.784-1.144-1.06l-.832-.921c-.284-.36-.629-1.093-1.243-1.985-.348-.504-1.027-1.085-1.284-1.579-.223-.425-.331-.954-.19-1.325.225-.594.675-.897 1.362-.832.519.05.848.206 1.238.537.225.19.573.534.75.748.163.195.203.276.377.509.23.307.302.459.214.121",strokeLinejoin:"round"}),f("path",{d:"m11.566 12.734v-3.459"}),f("path",{d:"m9.551 12.746-.016-3.473"}),f("path",{d:"m7.555 9.305.021 3.426"})]})]})})}function up(){return f("svg",{width:"30",height:"30",viewBox:"0 0 32 32",fill:"none",children:A("g",{transform:"translate(8 9)",children:[f("path",{d:"m3.44281398 1.68449726c-.74326136.27630142-1.05584685.8131257-1.07636853 1.38003696-.01344897.37336893.06665513.72649286.23114214 1.18694303-.02596219-.07267623.09676488.29282004.12116236.37362273.05052942.16918921-.4865367-.05865774-.81377307.00741883-.36363321.07113868-.84783757.38332307-1.10006887.79754775-.29643467.48542737-.3109609 1.04368567-.08235979 2.04824266.12491868.54736183.36572145 1.00836814.71076689 1.44594879.15329951.1944118.5713628.64726015.60307236.6875974l.84854343.94062339c.15080214.1358526.25794954.2361946.57590427.5380259.3147558.2987762.4647038.4380078.60308951.555976.05846214.0492474.10784267.1797116.12740685.3736249.01609788.1595565.01049553.3375341-.0090192.5090254-.00674888.0593077-.01325791.1020883-.01698742.1224696-.04189161.228932.13269563.4403386.36541902.4424835.21585671.0019894.38528595.0046546.82216479.0123538.09483476.0016698.09483476.0016698.18993053.0033129 1.16876447.0200186 1.75308289.0147904 2.17807912-.0385723.45429894-.0572869.92650915-.6110188 1.32698393-1.2957591.34289141.6108338.81859723 1.2057867 1.2995685 1.2820532.1510118.0244148.3353555.0322555.548787.0275887.1606725-.0035131.3307029-.0140241.5021961-.0293376.1276907-.0114022.2293359-.0228648.29003-.0307451.2258836-.0293282.373669-.251611.3133108-.4712481-.0130351-.0474332-.0339838-.1345011-.0551094-.2441635-.0245945-.1276687-.0423383-.2523857-.0503381-.365988-.0050217-.0713101-.0059948-.1359317-.0027687-.1918983.0059157-.0980798.0077938-.1530073.0108033-.281125.0010795-.0448938.0010795-.0448938.0024606-.0845172.0054208-.1364475.0233824-.2649146.0815132-.544638.0250088-.1201275.1473169-.352189.3398902-.639435.0571394-.0852302.1195783-.1742239.1864664-.26609712.1272143-.17473362.2641361-.35131772.4011075-.52030772.082051-.10123129.145482-.17695689.1808122-.21807676.2967593-.42378347.612817-1.11823437.7291396-1.52536348.1117407-.39153936.202351-1.12501196.254373-1.81690429.029923-.39968605.0410555-.72381216.0410555-1.23011613.0000742-.09758414.0000742-.09758414.0002975-.17670236.0003569-.11115478.0003569-.11115478.000115-.20711835-.0008934-.15683883-.0055282-.31323355-.0207085-.69507578-.0313109-.81293139-.4771727-1.33911388-1.1344906-1.44058831-.559108-.08631314-1.0586051.08188477-1.2779293.31625977-.0755526.08073733.0036753-.2781823-.2159489-.62316278-.1644465-.25841586-.593184-.58905957-.9209287-.65355552-.335487-.06535532-.73539548-.05811715-1.1017193.00667481-.32093157.05742909-.68608434.33741751-.87176225.64688068-.12411885.20686477.03884667-.00592296-.09368743-.23401341-.18231052-.31422641-.60754287-.59486422-1.01411454-.67799709-.34643562-.07139428-.74182572-.04452925-1.09945614.0633873-.43336319.1291117-1.01795827.61460976-.94899189 1.15552627-.34375-.54091651-1.25026717-.691379-1.97906097-.42111797z",fill:"#000"}),f("path",{d:"m7.31951013 1.62138197c.20710357.04234751.44724204.20083012.51632974.31990811.08404358.1446387.15562749.36413806.21048667.6366124.02933373.14569467.12179446 1.2125285.29383112 1.32370243.41279229.04533731.41279229.04533731.52658055-.12364345.03545705-.07383858.03545705-.07383858.04226523-.1029106.01416796-.06009544.02463332-.12677987.0351322-.21754028l.00854738-.07915386.00047673-.00942804.00327525-.03167185c.01085148-.11424313.04184125-.4312127.05388392-.53034902.03788792-.31189663.08766449-.52757784.13944093-.6138719.0713024-.11883734.31942298-.28274442.43149612-.30279961.2804398-.04960082.58940103-.05519288.82623993-.00905543.1084394.02134018.3709471.22378689.432331.32024744.1291079.20279957.2524316.84889766.3225486 1.4970065-.0102194.04624251-.0102194.04624251.1640069.28984194.5843296-.06677889.5843296-.06677889.5703629-.17490247.0159511-.03856429.0284824-.08294031.045969-.15118961.0423876-.16089067.0697594-.25204451.111066-.35549917.0288558-.07227096.0592914-.13391873.0904889-.18278042.1209187-.19031132.4335712-.319392.7077174-.27707028.2943447.04543991.4816904.26653537.4994912.72869815.0148821.37434892.0193146.5239164.0201469.6700184l-.0004247.37954865c0 .48831141-.0104951.79388164-.0389535 1.17400348-.0480918.63962116-.1348512 1.34192123-.227649 1.66708484-.0946325.33121345-.3766371.95084197-.6003915 1.27298482-.0161892.01580846-.0841508.09694273-.1710333.20413492-.1445842.17838247-.2892181.36491271-.4247891.5511244-.0723398.09936149-.1402862.19620479-.2030964.2898938-.2440054.36396314-.400553.66098894-.4512157.90434304-.0659304.3172546-.0893838.4850003-.0966379.6675968-.0017072.0490782-.0017072.0490782-.002845.096677-.0028064.119476-.004437.1671639-.0097087.2545848-.0052654.091322-.0038193.187354.00332.2887353.0103318.1467182.1058713.3478531.1058713.3478531s-.2321503-.0119819-.3742084-.0088758c-.1718098.0037567-.3147843-.0023244-.4138162-.0183342-.1440353-.0228411-.53014068-.5057331-.7278511-.8821737-.30227042-.5764228-1.03604858-.5484427-1.33684295-.0394061-.26854779.4591613-.65918083.9172326-.7740684.9317199-.37404082.0469647-.94643778.0520862-2.07160079.0328144-.09480875-.0016381-.46003446-.0128683-.64600494-.0157445-.18597048-.0028763.05008807-.1790283.02786486-.399297-.03726222-.36933-.15125405-.6704984-.38877094-.8705429-.12241569-.1043631-.26774964-.2393104-.56509654-.5215613-.33323493-.3163366-.44236499-.4185353-.57290215-.533275l-.80130455-.89071892c-.03955779-.05174211-.45812831-.5051399-.5872217-.6688539-.28069963-.35597842-.47062947-.71959073-.56844755-1.14820437-.18921973-.83150113-.1793328-1.21146622-.00855589-1.49112273.13743587-.2257023.43815377-.4195862.60596039-.45241793.17165981-.03465512.55153059-.01648617.62179422.02229321.09902279.05401056.13357243.07300285.16379074.09097645.03572494.02124891.05965747.03799198.08182912.05708809.03426437.02951139.07235014.07170412.12420211.14044502.03611591.04821025.07806642.1053997.1423779.19304882.06054643.0816627.09183576.12069421.13369221.1590035.28038907.25662728.68391532.03238058.65052057-.32606956-.00567036-.06086415-.02203766-.12694598-.05458621-.23708502-.04356824-.15021272.00433013-.05284275-.26002629-.56642281-.08720664-.16942124-.13955864-.28835362-.17428227-.4046158l-.03412852-.10219113c-.03838756-.11059767-.09558223-.26854489-.12612861-.35199347l-.02009957-.05467087.002.008-.05974804-.17751191c-.09232236-.28807194-.13413567-.51358087-.12645475-.72681781.01040781-.28751553.16037753-.54506871.58790983-.70400047.40142488-.1488616 1.07786076.00117106 1.20581167.27856864.04319814.09369738.08927466.21199471.13900415.35457792l.03930997.11680217c.05539717.16759437.13470873.41493582.13860471.42816881.02724222.08344874.0471839.13860719.06943813.18441246.00217869.06301886.00217869.06301886.35429398.23177937.41699479-.29154152.41699479-.29154152.38019201-.37525838.00571063-.08773482.00758408-.17356287.00965287-.37317647.00242546-.23402898.00423842-.33154773.00994479-.45966208.01316411-.29554918.0437926-.51142116.09291227-.63864415.09160418-.23801371.25279279-.40993649.4432431-.46667832.24458613-.07380253.51465245-.09215236.73323569-.04710649zm1.21356228 4.27672201c-.20710459.00095412-.37422255.16961903-.37326843.37672361l.016 3.473c.00095412.20710459.16961903.37422251.37672361.37326841.20710459-.0009541.37422255-.16961901.37326843-.37672359l-.016-3.473c-.00095412-.20710459-.16961903-.37422255-.37672361-.37326843zm2.03332759.00229602c-.2071068 0-.375.16789322-.375.375v3.459c0 .20710678.1678932.375.375.375s.375-.16789322.375-.375v-3.459c0-.20710678-.1678932-.375-.375-.375zm-4.01399856.02930704c-.20710289.00126946-.37396385.17018863-.3726944.37729152l.021 3.426c.00126946.20710289.17018863.37396384.37729152.37269444.20710289-.0012695.37396385-.17018867.3726944-.37729156l-.021-3.426c-.00126946-.20710289-.17018863-.37396385-.37729152-.3726944z",fill:"#fff"})]})})}function ip(){return A("svg",{width:"16",height:"16",viewBox:"0 0 20 20",fill:"none",xmlns:"http://www.w3.org/2000/svg",children:[f("circle",{cx:"10",cy:"10",r:"8",stroke:"rgba(0,0,0,0.15)",strokeWidth:"2"}),f("path",{d:"M10 2A8 8 0 0 1 18 10",stroke:"black",strokeWidth:"2",strokeLinecap:"round"})]})}var ap="M0-8.4 2.55-3.65H-2.55ZM0 8.4 2.55 3.65H-2.55Z";function As({turn:e}){return f("svg",{width:"21",height:"21",viewBox:"-14 -14 28 28",overflow:"visible",children:A("g",{transform:`rotate(${e})`,strokeLinejoin:"round",children:[f("path",{d:ap,style:{fill:"var(--ss-cursor-edge, #fff)",stroke:"var(--ss-cursor-edge, #fff)"},strokeWidth:"3.2"}),f("path",{d:ap,style:{fill:"var(--ss-cursor-line, #000)",stroke:"var(--ss-cursor-line, #000)"},strokeWidth:"1.2"})]})})}var dp=()=>f(As,{turn:0}),fp=()=>f(As,{turn:90}),cp=()=>f(As,{turn:-45}),pp=()=>f(As,{turn:45});var mp=document.createElement("style");mp.textContent=`/* The cursor (cursor.tsx): glyphs, the five styles, press, idle, ripples. */

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
`;document.head.appendChild(mp);var hp={pointer:np,ibeam:rp,crosshair:op,hand:sp,open:lp,grab:up,wait:ip,"resize-ns":dp,"resize-ew":fp,"resize-nwse":cp,"resize-nesw":pp},W0={pointer:{x:7.5,y:5.25},ibeam:{x:5,y:8},crosshair:{x:8.5,y:8.5},hand:{x:9.75,y:3.25},open:{x:11.7,y:10.4},grab:{x:12,y:12},wait:{x:8,y:8},"resize-ns":{x:10.5,y:10.5},"resize-ew":{x:10.5,y:10.5},"resize-nwse":{x:10.5,y:10.5},"resize-nesw":{x:10.5,y:10.5}},V0={x:4,y:3};function G0(){return f("svg",{width:"22",height:"22",viewBox:"0 0 22 22",className:"ss-cursor__arrow","aria-hidden":!0,children:f("path",{d:"M4 3 18.5 9.6 11.8 11.8 9.6 18.5Z"})})}function gp({cursorRef:e,style:t="real",kind:a}){return A("div",{ref:e,className:"ss-cursor","data-style":t,"data-kind":a,"aria-hidden":!0,children:[t==="touch"&&f("span",{className:"ss-cursor__streak"}),A("div",{className:"ss-cursor__press",children:[(t==="circle"||t==="touch")&&f("span",{className:"ss-cursor__dot"}),t!=="circle"&&t!=="touch"&&Object.keys(hp).map((n)=>{let r=t==="arrow";if(r&&n!=="pointer"&&n!=="ibeam")return null;let o=r&&n==="pointer"?G0:hp[n],s=r&&n==="pointer"?V0:W0[n];return f("div",{className:"ss-cursor__glyph","data-glyph":n,"data-active":n===(r&&a!=="ibeam"?"pointer":a),style:{marginLeft:-s.x,marginTop:-s.y,transformOrigin:`${s.x}px ${s.y}px`},children:f(o,{})},n)})]})]})}function xp(e,t){let a=document.createElement("span");a.className="ss-ripple",a.style.left=`${t.x}px`,a.style.top=`${t.y}px`,e.appendChild(a),a.addEventListener("animationend",()=>a.remove())}ut();var di=Tn({theme:"light",palette:"accent",fidelity:"standard",layout:"wide"}),Lp=()=>Fn(di);ut();var fi=Tn(!1);function yp(){let e=Fn(fi),[t,a]=pe(!1);return kt(()=>{let n=window.matchMedia("(prefers-reduced-motion: reduce)"),r=()=>a(n.matches);return r(),n.addEventListener("change",r),()=>n.removeEventListener("change",r)},[]),e||t}var ma={now:()=>performance.now(),raf:(e)=>requestAnimationFrame(e),cancelRaf:(e)=>cancelAnimationFrame(e),layoutRaf:(e)=>ma.recording?.requestLayoutFrame(e)??requestAnimationFrame(e),cancelLayoutRaf:(e)=>{let t=ma.recording;if(t)t.cancelLayoutFrame(e);else cancelAnimationFrame(e)},timeout:(e,t)=>window.setTimeout(e,t),clearTimeout:(e)=>window.clearTimeout(e),get recording(){return typeof window>"u"?null:window.__stageshow?.clock??null}};var j0={};function Ts({width:e,height:t,initial:a=j0,script:n,poster:r,cursor:o,hover:s,play:l="loop",compact:u,keys:c="bottom",palette:m="accent",greys:g,fidelity:h="standard",specimen:L,unframed:x,speed:C=1,accent:E,tokens:d,ground:i,fill:p=!1,theme:v="light",className:w,children:z}){let D=l==="hover"&&typeof window<"u"&&window.matchMedia("(hover: none)").matches?"once":l,[y,Q]=pe("wide"),B=Z(y);B.current=y;let V=()=>{let T=o.at;return typeof T==="object"&&"wide"in T?T[B.current]:T},[rt,De]=pe(!1),ye=y==="compact"&&u?u.width:e,Lt=y==="compact"&&u?u.height:t,Ve=Z(null),ve=Z(null),$e=Z(null),ot=yp(),ke=!n||ot,[b,S]=pe(()=>ke&&r?r:a),I=Z(b);I.current=b;let[P,M]=pe(1),N=Z(1);N.current=P;let X=typeof window>"u"?{}:window.__stageshow??{},ue=C/(X.slow??1),_=X.theme??v,[O,ie]=pe(o?.kind??"pointer"),j=(T)=>{let U=ve.current;if(!U||ot)return;xp(U,T)},fe=Z(O);fe.current=O;let[Be,Ce]=pe({id:0,caps:[],show:!1,down:!1}),[Ua,G]=pe(null),Se=Z(Be);Se.current=Be;let J=Z({x:0,y:0}),he=Z(null),[qa,Sn]=pe(0),yt=Z(!1),Ha=Z(!1),ao=Z(null);lt(()=>{let T=Ve.current;if(!T)return;let U=()=>{let ee=T.clientWidth,vt=!!T.parentElement?.closest("[data-ss-wide]"),wt=u&&!vt&&ee<u.below?"compact":"wide";Q(wt);let Tt=p||!!T.parentElement?.closest("[data-ss-fill]");De(Tt);let It=wt==="compact"?u.width:e,st=Math.min(Tt?2:1,ee/It);M(st),Sn(Math.max(0,(ee-It*st)/2))};U();let W=new ResizeObserver(U);W.observe(T);let q=new MutationObserver(U);for(let ee=T.parentElement;ee;ee=ee.parentElement)q.observe(ee,{attributes:!0,attributeFilter:["data-ss-wide","data-ss-fill"]});return()=>{W.disconnect(),q.disconnect()}},[e,u?.below,u?.width,p]);let[no,Wa]=pe({}),zs=Ft(()=>{let T=ve.current;if(!T)return{};let U={},W=T.querySelectorAll("[data-target]");if(!W.length)return U;let q=bs(T,N.current);return W.forEach((ee)=>{U[ee.dataset.target]=$c(T,ee,N.current,q)}),U},[]),Ds=Z({n:0,frame:0,owed:!1}),xa=Ft(()=>{let T=Ds.current;if(!T.frame)T.frame=ma.layoutRaf(()=>{if(T.n=0,T.frame=0,!T.owed)return;T.owed=!1;let W=zs();Wa((q)=>ui(q,W)?q:W)});if(T.n>=4){T.owed=!0;return}T.n++;let U=zs();Wa((W)=>ui(W,U)?W:U)},[zs]);lt(xa),lt(()=>()=>{ma.cancelLayoutRaf(Ds.current.frame),Ds.current={n:0,frame:0,owed:!1}},[]),kt(()=>{let T=ve.current;if(!T)return;return T.addEventListener("transitionend",xa),T.addEventListener("animationend",xa),()=>{T.removeEventListener("transitionend",xa),T.removeEventListener("animationend",xa)}},[xa]);let Hp=Ft((T)=>no[T]??Ss,[no]),[Wp,pi]=pe(!0);lt(()=>{pi(!0);let T=!0,U=0,W=()=>{U=ma.layoutRaf(()=>{U=ma.layoutRaf(()=>T&&pi(!1))})};if(!document.fonts||document.fonts.status==="loaded")W();else document.fonts.ready.then(()=>T&&W());return()=>{T=!1,ma.cancelLayoutRaf(U)}},[y]);let Va=Z(0),Pn=Z(0),bn=Z(!1),Bs=Z(null),Ga=Ft((T)=>{if(Pn.current&&!bn.current&&Math.hypot(T.x-J.current.x,T.y-J.current.y)>0.5)bn.current=!0,Bs.current??=performance.now()-Pn.current;J.current=T,Va.current=performance.now();let U=$e.current;if(!U)return;U.style.transform=`translate(${T.x}px, ${T.y}px)`,U.removeAttribute("data-idle")},[]),La=Ft((T)=>{if(typeof T==="object"&&T!==null&&"wide"in T)T=B.current==="compact"?T.compact:T.wide;let U=Ps(T);if(U===null)return T;let W=ve.current,q=W?.querySelector(`[data-target="${U}"]`);if(!W||!q)return fa(`no element with data-target="${U}"`),J.current;let ee=Na(W,q,N.current),vt=typeof T==="string"?{x:0.5,y:0.5}:T;return{x:ee.x+ee.width*vt.x,y:ee.y+ee.height*vt.y}},[]);lt(()=>{if(!ke||!s)return;let T=ve.current;s.forEach((U)=>T?.querySelector(`[data-target="${U}"]`)?.setAttribute("data-hover",""))}),lt(()=>{if(o&&!Pn.current)Ga(La(V()))},[P,y]);let Es=Z(0),ya=Z(0),ro=Ft(()=>{++Es.current,cancelAnimationFrame(ya.current),ya.current=0,ve.current?.removeAttribute("data-settling")},[]),_s=Ft((T=!1)=>{ro();let U=Es.current;if(Ha.current=!1,S(a),ie(o?.kind??"pointer"),Ce((q)=>({...q,show:!1,down:!1})),G(null),ve.current?.querySelectorAll("[data-hover],[data-pressed]").forEach((q)=>{q.removeAttribute("data-hover"),q.removeAttribute("data-pressed")}),ve.current?.removeAttribute("data-mark"),ve.current?.querySelectorAll("[data-scrolled]").forEach((q)=>{q.scrollTop=0,q.removeAttribute("data-scrolled"),Ms(q)}),ve.current?.querySelectorAll("[data-scrolling]").forEach((q)=>q.removeAttribute("data-scrolling")),$e.current?.removeAttribute("data-pressed"),ao.current=null,!o)return;if(!T){ya.current=requestAnimationFrame(()=>{ya.current=0,Ga(La(V())),he.current?.(J.current)});return}let W=ve.current;W?.setAttribute("data-settling",""),ya.current=requestAnimationFrame(()=>{let q={...J.current},ee=La(V()),vt=ca(320+Math.hypot(ee.x-q.x,ee.y-q.y)*0.7,380,700),wt=performance.now(),Tt=()=>{if(Es.current!==U)return;let It=Math.min(1,(performance.now()-wt)/vt),st=Cn(It);if(Ga({x:q.x+(ee.x-q.x)*st,y:q.y+(ee.y-q.y)*st}),It<1)ya.current=requestAnimationFrame(Tt);else ya.current=0,W?.removeAttribute("data-settling")};Tt()})},[y]),mi=so(()=>(T)=>ep(T,{rootRef:ve,cursorRef:$e,pos:J,hovered:ao,kindRef:fe,keysRef:Se,dragging:Ha,autoUsed:yt,autoRef:he,scaleRef:N,speed:ue,layout:y,cursor:o,resolve:La,place:Ga,remeasure:xa,ripple:j,setState:S,setKind:ie,setKeys:Ce,setLastKeys:G}),[La,Ga,ue,y]);kt(()=>{let T=ve.current;if(ke||!n)return _s(),T.removeAttribute("data-offscreen"),S(r??a),ro;_s();let U=Ve.current,W=null,q=!1,ee=!1,vt=!1,wt=o?.idle??4000,Tt=1200,It=0,st=0,jp=()=>{if(window.clearInterval(It),!o||wt===!1)return;Va.current=performance.now(),It=window.setInterval(()=>{let ce=$e.current;if(!ce)return;let Ze=performance.now();if(!bn.current){if(Bs.current===null&&Ze-Va.current>Tt)ce.setAttribute("data-idle","");return}if(ce.hasAttribute("data-pressed")||ve.current?.querySelector("[data-hover]"))Va.current=Ze;else if(Ze-Va.current>wt)ce.setAttribute("data-idle","")},150)},Kp=()=>{Pn.current=performance.now(),bn.current=!1,window.clearTimeout(st);let ce=$e.current,Ze=Bs.current;if(wt===!1||!ce||Ze===null||Ze<=Tt)return;ce.setAttribute("data-idle",""),st=window.setTimeout(()=>ce.removeAttribute("data-idle"),Ze-400)},Os=()=>{window.clearInterval(It),window.clearTimeout(st),Pn.current=0,$e.current?.removeAttribute("data-idle")},Xp=()=>{window.clearInterval(It),window.clearTimeout(st);let ce=$e.current,Ze=()=>ce?.hasAttribute("data-pressed")||T.querySelector("[data-hover]");if(!o||wt===!1||!ce||ce.hasAttribute("data-idle")||Ze())return;let oo=(bn.current?wt:Tt)-(performance.now()-Va.current);st=window.setTimeout(()=>{if(!Ze())ce.setAttribute("data-idle","")},Math.max(0,oo))},Ns=()=>{if(W||vt||!q||document.hidden)return;if(D==="hover"&&!ee)return;if(ro(),o)Ga(La(V()));W=new AbortController;let ce=W.signal;jp();let Ze=mi(ce);(async()=>{do{Kp();try{await n(Ze)}catch(oo){if(oo instanceof pa)return;console.error("[stageshow] script error",oo),W=null,Os();return}if(D==="loop"&&ii())tp(I.current,a,J.current,o?La(V()):null)}while(D==="loop"&&!ce.aborted);if(D==="once"&&!ce.aborted)vt=!0,Xp()})()},Us=(ce=!1)=>{if(Os(),!W)return;if(W.abort(),W=null,!vt)_s(ce)},qs=()=>T.toggleAttribute("data-offscreen",!q||document.hidden);qs();let hi=new IntersectionObserver(([ce])=>{q=ce.isIntersecting,qs(),q?Ns():Us()});hi.observe(U);let gi=()=>{qs(),document.hidden?Us():Ns()};document.addEventListener("visibilitychange",gi);let xi=()=>{ee=!0,Ns()},Li=()=>{ee=!1,Us(!0)};if(D==="hover")U.addEventListener("pointerenter",xi),U.addEventListener("pointerleave",Li);return()=>{hi.disconnect(),document.removeEventListener("visibilitychange",gi),U.removeEventListener("pointerenter",xi),U.removeEventListener("pointerleave",Li),Os(),W?.abort(),W=null,he.current=null,ro()}},[ke,n,mi,D,y]),lt(()=>{if(o&&!ke&&!Ha.current)he.current?.(J.current)},[b]);let Vp=so(()=>({theme:_,palette:m,fidelity:h,layout:y}),[_,m,h,y]),Gp=o&&(!n||!ke||o.still);return f("div",{ref:Ve,className:`ss-fit${w?` ${w}`:""}`,style:{maxWidth:rt?void 0:e,height:Lt*P},children:A("div",{ref:ve,className:"ss-stage","data-specimen":L||void 0,"data-unframed":x||void 0,"data-still":ke||void 0,"data-placing":Wp||void 0,"data-theme":_,"data-palette":m,"data-greys":g==="cool"?"cool":void 0,"data-fidelity":h,"data-layout":y,style:{width:ye,height:Lt,marginLeft:qa||void 0,transform:`scale(${P})`,...d,...E?{["--ss-accent"]:E,["--ss-accent-2"]:E,["--ss-accent-soft"]:`color-mix(in srgb, ${E} 14%, transparent)`}:null},children:[i&&f("div",{className:"ss-ground","aria-hidden":!0,style:Array.isArray(i)?{["--ss-orb-1"]:i[0],["--ss-orb-2"]:i[1],...i[2]?{["--ss-orb-3"]:i[2]}:null}:void 0}),f(fi.Provider,{value:ke,children:f(di.Provider,{value:Vp,children:z(b,Hp,y)})}),n&&f(Kc,{rows:[Ua,Be],at:typeof c==="string"?c:c[y]}),Gp&&f(gp,{cursorRef:$e,style:o.style,kind:O})]})})}ut();var vp=document.createElement("style");vp.textContent=`/* Phones (phone.tsx): frames, the status bar, the lock screen and
   notification banners. */

@layer stageshow {
  /* Zero specificity for the positioning, so a demo's own class (.xx-phone
     { position: absolute }) wins whichever stylesheet happens to load last */
  :where(.ss-phone) {
    position: relative;
  }

  .ss-phone {
    flex-shrink: 0;
    box-shadow:
      0 calc(var(--ps) * 40) calc(var(--ps) * 80) calc(var(--ps) * -16) rgba(50, 50, 93, 0.25),
      0 calc(var(--ps) * 24) calc(var(--ps) * 48) calc(var(--ps) * -24) rgba(0, 0, 0, 0.3);
  }

  .ss-phone__glass {
    height: 100%;
  }

  .ss-phone__window {
    position: relative;
    overflow: hidden;
    /* Keeps the scaled screen clipped to the rounded corners in Safari */
    isolation: isolate;
  }

  /* The iOS frames paint their bands as strokes of the screen's outline
     (Phone's BANDS), from these colors; the body and glass paint nothing */
  .ss-phone:is([data-frame="pro"], [data-frame="silver"], [data-frame="bezel"], [data-frame="clay"], [data-frame="outline"], [data-frame="bare"]) {
    --ss-phone-glass: #0b0b0c;
    --ss-phone-rim: #2c2c2d;
    --ss-phone-seam: #e0dfdc;
    --ss-phone-line: var(--ss-text-faint, #9a9a9d);
    background: none;
  }

  .ss-phone__bands {
    position: absolute;
    inset: 0;
    overflow: visible;
    pointer-events: none;
  }

  .ss-phone:is([data-frame="pro"], [data-frame="silver"], [data-frame="bezel"], [data-frame="clay"], [data-frame="outline"]) .ss-phone__glass {
    position: relative;
  }

  /* Pro: brushed titanium band around black glass */
  .ss-phone[data-frame="pro"] {
    --ss-phone-band-1: #e3e3e6;
    --ss-phone-band-2: #9a9ba0;
    --ss-phone-band-3: #cfd0d4;
    --ss-phone-band-4: #85868b;
    --ss-phone-band-5: #c9cacd;
  }

  /* On dark stages, black titanium: a light band would be the brightest thing in the shot */
  .ss-stage[data-theme="dark"] .ss-phone[data-frame="pro"],
  .ss-stage[data-theme="glass"] .ss-phone[data-frame="pro"][data-dark] {
    --ss-phone-band-1: #5b5c61;
    --ss-phone-band-2: #2b2c2f;
    --ss-phone-band-3: #48494d;
    --ss-phone-band-4: #232427;
    --ss-phone-band-5: #404145;
  }

  /* Silver: light titanium around black glass */
  .ss-phone[data-frame="silver"] {
    --ss-phone-band-1: #f4f4f6;
    --ss-phone-band-2: #c9cacf;
    --ss-phone-band-3: #eeeef1;
    --ss-phone-band-4: #b9babf;
    --ss-phone-band-5: #e6e6ea;
  }

  /* Bezel: a plain black border */
  .ss-phone[data-frame="bezel"] {
    --ss-phone-glass: #111113;
  }

  /* Clay: one matte color, soft and thick, lit from above like a rendered
     model rather than a black ring. Light by default; set --ss-phone-clay */
  .ss-phone[data-frame="clay"] {
    --ss-phone-clay-top: color-mix(in srgb, var(--ss-phone-clay, #ecebe8), #fff 45%);
    --ss-phone-clay-bottom: color-mix(in srgb, var(--ss-phone-clay, #ecebe8), #000 6%);
    box-shadow:
      0 calc(var(--ps) * 30) calc(var(--ps) * 60) calc(var(--ps) * -12) rgba(50, 50, 93, 0.2),
      0 calc(var(--ps) * 16) calc(var(--ps) * 32) calc(var(--ps) * -16) rgba(0, 0, 0, 0.16);
  }

  .ss-stage[data-theme="dark"] .ss-phone[data-frame="clay"] {
    --ss-phone-clay-top: color-mix(in srgb, var(--ss-phone-clay, #2a2a2e), #fff 6%);
    --ss-phone-clay-bottom: var(--ss-phone-clay, #2a2a2e);
    --ss-phone-seam: #333338;
  }

  /* Outline: line art. One fine stroke for the body, a hairline for the
     screen; no shadow, nothing filled */
  .ss-phone[data-frame="outline"] {
    box-shadow: none;
  }

  .ss-stage[data-theme="blueprint"] .ss-phone[data-frame="outline"] {
    --ss-phone-line: var(--ss-line);
  }

  /* Every iPhone frame lays the status bar out exactly as Apple's iOS 27 UI
     kit does (Status bar, iPhone, in points): the time centered in the first
     138.5, its 22pt line from y 21.5; signal, wifi and battery from x 285.25,
     8 apart, their tops at 26.33, 25.33 and 25.67 */
  .ss-phone:not([data-frame="android"], [data-frame="soft"]) .ss-phone__status {
    height: 62px;
    padding: 0;
  }

  .ss-phone:not([data-frame="android"], [data-frame="soft"]) .ss-phone__time {
    position: absolute;
    top: 21.5px;
    left: 0;
    width: 138.5px;
    line-height: 22px;
    text-align: center;
  }

  .ss-phone:not([data-frame="android"], [data-frame="soft"]) .ss-phone__glyphs {
    position: absolute;
    top: 25.33px;
    left: 285.25px;
    align-items: flex-start;
    gap: 8px;
  }

  .ss-phone:not([data-frame="android"], [data-frame="soft"]) .ss-phone__signal {
    margin-top: 1px;
  }

  .ss-phone:not([data-frame="android"], [data-frame="soft"]) .ss-phone__battery {
    margin-top: 0.33px;
  }

  /* Photo: Apple's iPhone 18 Pro product bezel, silver, black on dark stages.
     The body paints nothing but keeps the phone's soft shadow (a shadow on
     the image would also fall inward, through its cut-out, onto the screen);
     the image lies over the screen, its cut-out framing it */
  .ss-phone[data-frame="photo"] {
    position: relative;
    background: none;
  }

  .ss-phone__photo {
    position: absolute;
    z-index: 4;
    background: var(--ss-phone-photo-light, none) center / 100% 100% no-repeat;
    pointer-events: none;
  }

  .ss-stage[data-theme="dark"] .ss-phone__photo,
  .ss-phone[data-dark] .ss-phone__photo {
    background-image: var(--ss-phone-photo-dark, var(--ss-phone-photo-light, none));
  }

  /* Android: an even dark frame, a punch-hole camera instead of an island */
  .ss-phone[data-frame="android"] {
    background: linear-gradient(150deg, #3a3b3f, #1d1e21 40%, #2f3034 70%, #1a1b1e);
  }

  .ss-phone[data-frame="android"] .ss-phone__glass {
    background: #050505;
  }

  .ss-phone[data-frame="android"] .ss-phone__island {
    top: 14px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
  }

  .ss-phone[data-frame="android"] .ss-phone__status {
    height: 48px;
    padding: 0 26px;
  }

  .ss-phone[data-frame="android"] .ss-phone__time {
    font-family: system-ui, sans-serif;
    font-size: 15px;
    font-weight: 500;
  }

  .ss-phone[data-frame="android"] .ss-phone__content[data-status] {
    padding-top: 48px;
  }

  .ss-phone[data-frame="android"] .ss-phone__home {
    width: 108px;
    height: 4px;
  }

  /* Soft: a frosted white frame with a hairline edge. */
  /* Soft: the illustrative phone of a product marketing page. One pale,
     even band with a hairline ring, a soft shade along its inner bottom edge
     (lit from above), a light lifted shadow; no island, no status bar */
  .ss-phone[data-frame="soft"] {
    box-shadow:
      0 0 0 calc(var(--ps) * 1.5) rgba(10, 37, 64, 0.05),
      0 calc(var(--ps) * 30) calc(var(--ps) * 60) calc(var(--ps) * -12) rgba(50, 50, 93, 0.18),
      0 calc(var(--ps) * 18) calc(var(--ps) * 36) calc(var(--ps) * -18) rgba(0, 0, 0, 0.12);
  }

  .ss-phone[data-frame="soft"] .ss-phone__glass {
    background: #f6f9fc;
    box-shadow: inset 0 calc(var(--ps) * -2.9) calc(var(--ps) * 7.2) rgba(10, 37, 64, 0.22);
  }

  .ss-stage[data-theme="dark"] .ss-phone[data-frame="soft"] .ss-phone__glass {
    background: #1c2433;
    box-shadow: inset 0 calc(var(--ps) * -2.9) calc(var(--ps) * 7.2) rgba(0, 0, 0, 0.45);
  }

  .ss-phone__screen {
    --pt: 1px;
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* Most iOS screens are white; a grouped list (Settings) sets #f2f2f7 itself */
    background: #fff;
    color: #000;
    font-family: -apple-system, system-ui, sans-serif;
    font-size: 15px;
    letter-spacing: -0.015em;
    transform-origin: 0 0;
    -webkit-font-smoothing: antialiased;
  }

  .ss-phone[data-dark] .ss-phone__screen {
    background: #000;
    color: #fff;
  }

  .ss-phone__status {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 54px;
    padding: 0 34px 0 52px;
    /* Light to dark content fades, never cuts, when an app opens over a dark
       screen or closes back to it */
    transition: color 0.3s ease;
    /* A layer of its own for good: when an app launches under it, it would
       otherwise be lifted onto one mid-open and its text would shift */
    will-change: transform;
  }

  /* iOS sets the time in SF Pro Text. At this size a browser's system font
     switches to the Display cut, whose 9 has a straighter tail; name Text
     first, and ask the variable system font for text optics */
  .ss-phone__time {
    font-family: "SF Pro Text", -apple-system, system-ui, sans-serif;
    font-variation-settings: "opsz" 17;
    font-size: 17.67px;
    font-weight: 590;
    letter-spacing: 0;
  }

  .ss-phone__island {
    position: absolute;
    top: var(--ss-island-top, 14px);
    left: 50%;
    z-index: 3;
    width: var(--ss-island-w, 95px);
    height: 37px;
    border-radius: 18.5px;
    background: #000;
    transform: translateX(-50%);
  }

  .ss-phone__glyphs {
    display: flex;
    align-items: center;
    gap: 8px;
  }


  .ss-phone__glyph {
    display: block;
  }

  .ss-phone__content {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  .ss-phone__content[data-status] {
    padding-top: 62px;
  }

  /* Frames without a status bar keep its safe area: content starts below the
     corner's curve, never tucked into it */
  .ss-phone__content:not([data-status]) {
    padding-top: 44px;
  }

  /* With no frame, the screen's edge is the object's edge, and iOS's 20pt
     margins read as cramped against it. Bare screens get a wider margin */
  .ss-phone[data-frame="bare"] .ss-phone__content {
    padding-right: 8px;
    padding-left: 8px;
  }

  .ss-phone__home {
    position: absolute;
    bottom: 8px;
    left: 50%;
    z-index: 2;
    width: 144px;
    height: 5px;
    border-radius: 2.5px;
    background: currentColor;
    transform: translateX(-50%);
    /* The color fades, not the fill: currentColor is a keyword, so a
       background-color transition never sees it change and the bar snaps */
    transition: color 0.3s ease;
    /* Its own layer for good, as the status bar: lifted onto one mid-open,
       the thin bar would jump half a pixel and thin out */
    will-change: transform;
  }

  .ss-lock {
    position: absolute;
    inset: 0;
    color: #fff;
    text-align: center;
  }

  .ss-lock__date {
    margin-top: 66px;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
    opacity: 0.85;
  }

  .ss-lock__clock {
    margin-top: -4px;
    font-size: 112px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.035em;
    font-variant-numeric: tabular-nums;
    opacity: 0.92;
  }

  .ss-lock__stack {
    position: absolute;
    right: 0;
    bottom: 118px;
    left: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    text-align: left;
  }

  /* Under the clock instead, for a phone cropped by the stage's bottom edge */
  .ss-lock__stack[data-at='top'] {
    top: 290px;
    bottom: auto;
  }

  .ss-lock__controls {
    position: absolute;
    right: 46px;
    bottom: 48px;
    left: 46px;
    display: flex;
    justify-content: space-between;
  }

  .ss-lock__control {
    display: grid;
    place-items: center;
    width: 50px;
    height: 50px;
    border-radius: 50%;
    /* The lock screen's frosted buttons: a dim, blurred disc with a white glyph */
    background: rgba(10, 12, 24, 0.26);
    backdrop-filter: blur(24px) saturate(1.3);
    color: #fff;
  }

  /* iOS notification banner, in points, measured from Apple's own iOS 26
     screenshots: 38pt icon 14pt from the edges, 13pt to the text, 17pt on the
     right, 15pt type on 18pt lines. The radius is the icon's 9 plus 14. On a
     wallpaper it is frosted glass, so the wallpaper tints it. */
  .ss-notification {
    display: flex;
    align-items: center;
    gap: 13px;
    /* Inset well inside the screen's corners, as iOS sets lock screen banners.
       Where the stage (or a clipping tile) cuts the screen's sides, the
       banner measures the cut and insets from the visible edge instead, so
       a phone drawn past the sides at true size keeps its banner whole */
    margin: 0 18px;
    padding: 14px 17px 14px 14px;
    border-radius: 23px;
    background: rgba(252, 252, 253, 0.76);
    backdrop-filter: blur(30px) saturate(1.25);
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
    color: #000;
    text-align: left;
  }

  /* Unlocked: the banner drops in at the top, just under the island, over
     the app. Mount and unmount it with the story; it eases down from above */
  .ss-notification[data-banner] {
    position: absolute;
    top: 56px;
    right: 0;
    left: 0;
    /* Over the status bar (the same layer, later in the page) and under the
       island, which is the hardware cutout: a banner slides in beneath it */
    z-index: 2;
    animation: ss-banner-in 520ms cubic-bezier(0.2, 0.9, 0.25, 1) both;
  }

  @keyframes ss-banner-in {
    from { transform: translateY(-110px); }
  }

  .ss-notification__icon {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    width: 38px;
    height: 38px;
    overflow: hidden;
    border-radius: 9px;
    background: var(--ss-accent);
    color: #fff;
  }

  /* A real app icon: the image is the whole tile, its own corners included */
  .ss-notification__icon:has(> img) {
    background: none;
  }

  .ss-notification__icon > img {
    display: block;
    width: 100%;
    height: 100%;
  }

  .ss-notification__text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    font-size: 15px;
    line-height: 18px;
    letter-spacing: -0.016em;
  }

  .ss-notification__head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .ss-notification__title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-weight: 600;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .ss-notification__time {
    flex-shrink: 0;
    font-size: 12px;
    letter-spacing: -0.005em;
    color: rgba(60, 60, 67, 0.6);
  }

  /* Wraps to three lines, as iOS shows a banner's body */
  .ss-notification__body {
    display: -webkit-box;
    overflow: hidden;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
  }

  /* Satellite: a phone beside a window. No controls, and notifications stack
     under the clock so a cropped phone still shows them. Everything stays at
     true iOS proportion: a notification is never scaled up to read. */
  .ss-lock[data-size='satellite'] .ss-lock__stack {
    top: 232px;
    bottom: auto;
  }

  /* No clock: the stack takes its place, just under the status bar, as
     Notification Center sits, rather than floating where the clock was */
  .ss-lock[data-size='satellite'][data-clock='off'] .ss-lock__stack {
    top: 74px;
  }

  /* Small boxes with text keep a layer of their own. Pushed by a row opening
     above them, or carried along by anything that moves by layout, their text
     would step whole pixels while the fill glides, and hop about inside it */
  .ss-notification {
    will-change: transform;
  }

  /* A banner on a light screen needs its own edge: frosted white on white vanishes */
  .ss-phone:not([data-dark]) .ss-notification {
    background: rgba(255, 255, 255, 0.92);
    box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.08), 0 8px 24px rgba(0, 0, 0, 0.12);
  }

  /* Minimal fidelity: the status bar time is a placeholder like any other word */
  .ss-phone__time-bar {
    display: inline-block;
    width: 30px;
    height: 7px;
    border-radius: 4px;
    background: currentColor;
    opacity: 0.5;
  }
}
`;document.head.appendChild(vp);var K0={w:402,h:874,r:64},wp={a:71,n:2.31},X0={w:393,h:829,r:42},$0={w:412,h:915,r:38},Z0={pro:{band:3,glass:10},photo:{band:0,glass:16},bezel:{band:0,glass:12},soft:{band:0,glass:12.5},bare:{band:0,glass:0},silver:{band:4,glass:9},clay:{band:0,glass:16},outline:{band:0,glass:8},android:{band:2,glass:9}},Q0={pro:[[13,"band"],[10,"var(--ss-phone-rim)"],[9.25,"var(--ss-phone-glass)"]],silver:[[13,"band"],[9,"var(--ss-phone-glass)"]],bezel:[[12,"var(--ss-phone-glass)"]],clay:[[16,"clay"],[1,"var(--ss-phone-seam)"]]};function Y0(e,t,a,n){let o=2/n,s=[];return[[e-a,a,1,-1],[e-a,t-a,1,1],[a,t-a,-1,1],[a,a,-1,-1]].forEach(([u,c,m,g],h)=>{for(let L=0;L<=32;L++){let x=L/32*(Math.PI/2),C=h%2===0?Math.sin(x):Math.cos(x),E=h%2===0?Math.cos(x):Math.sin(x);s.push(`${(u+m*a*Math.pow(C,o)).toFixed(2)} ${(c+g*a*Math.pow(E,o)).toFixed(2)}`)}}),`M${s.join("L")}Z`}function Rs({width:e,frame:t="pro",time:a="9:41",island:n,status:r,dark:o,wallpaper:s,className:l,style:u,children:c,...m}){let g=Z(null),[h,L]=pe(!0);kt(()=>{if(t!=="photo"||!g.current)return;let ye=getComputedStyle(g.current).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/)?.[1];if(!ye)return void L(!1);let Lt=!0,Ve=new Image;return Ve.onerror=()=>Lt&&L(!1),Ve.src=ye,()=>{Lt=!1}},[t,o]);let x=t==="photo"&&!h?"pro":t,{band:C,glass:E}=Z0[x],{fidelity:d}=Lp(),i=x==="android"?$0:x==="soft"?X0:K0,p=C+E,v=e/(i.w+p*2),w=(De)=>De*v,z=Vs().replace(/:/g,""),y=x!=="android"&&x!=="soft"?Y0(w(i.w),w(i.h),w(wp.a),wp.n):null,Q=Q0[x],B=x==="pro"||x==="photo"||x==="bezel"||x==="silver"||x==="android",V=n??(B&&x!=="photo"),rt=r??B;return A("div",{...m,className:`ss-phone${l?` ${l}`:""}`,"data-frame":x,"data-dark":o||void 0,style:{width:e,height:w(i.h+p*2),padding:w(C),borderRadius:w(i.r+p),["--ps"]:`${v}px`,...u},children:[(Q||x==="outline")&&y&&A("svg",{className:"ss-phone__bands",width:"100%",height:"100%","aria-hidden":!0,children:[A("defs",{children:[f("linearGradient",{id:`${z}-band`,x1:"0.2",y1:"0",x2:"0.8",y2:"1",children:[0,0.22,0.48,0.74,1].map((De,ye)=>f("stop",{offset:De,style:{stopColor:`var(--ss-phone-band-${ye+1})`}},De))}),A("linearGradient",{id:`${z}-clay`,x1:"0",y1:"0",x2:"0",y2:"1",children:[f("stop",{offset:"0",style:{stopColor:"var(--ss-phone-clay-top)"}}),f("stop",{offset:"1",style:{stopColor:"var(--ss-phone-clay-bottom)"}})]}),x==="outline"&&A("mask",{id:`${z}-ring`,maskUnits:"userSpaceOnUse",x:"-50%",y:"-50%",width:"200%",height:"200%",children:[f("path",{d:y,fill:"none",stroke:"#fff",strokeWidth:w(16)}),f("path",{d:y,fill:"none",stroke:"#000",strokeWidth:w(16)-2})]})]}),f("g",{transform:`translate(${w(p)} ${w(p)})`,strokeLinejoin:"round",children:x==="outline"?A(Oa,{children:[f("rect",{x:-w(9),y:-w(9),width:w(i.w+18),height:w(i.h+18),mask:`url(#${z}-ring)`,style:{fill:"var(--ss-phone-line)"}}),f("path",{d:y,fill:"none",strokeWidth:"2",style:{stroke:"var(--ss-line, rgba(0, 0, 0, 0.06))"}})]}):Q.map(([De,ye])=>f("path",{d:y,fill:"none",strokeWidth:w(De*2),stroke:ye==="band"||ye==="clay"?`url(#${z}-${ye})`:void 0,style:ye==="band"||ye==="clay"?void 0:{stroke:ye}},De))})]}),f("div",{className:"ss-phone__glass",style:{padding:w(E),borderRadius:w(i.r+E)},children:f("div",{className:"ss-phone__window",style:{width:w(i.w),height:w(i.h),borderRadius:y?void 0:w(i.r),clipPath:y?`path('${y}')`:void 0},children:A("div",{className:"ss-phone__screen",style:{width:i.w,height:i.h,transform:`scale(${v})`,["--ss-screen-r"]:`${i.r}px`,...s?{background:s}:null},children:[rt&&A("div",{className:"ss-phone__status",children:[f("span",{className:"ss-phone__time",children:d==="minimal"?f("span",{className:"ss-phone__time-bar"}):a}),A("span",{className:"ss-phone__glyphs",children:[f(J0,{}),f(e1,{}),f(t1,{})]})]}),V&&f("span",{className:"ss-phone__island"}),f("div",{className:"ss-phone__content","data-status":rt||void 0,children:c}),B&&f("span",{className:"ss-phone__home"})]})})}),x==="photo"&&f("span",{ref:g,className:"ss-phone__photo",style:{left:w(-8),top:w(-7),width:w(450),height:w(920)}})]})}function J0(){return f("svg",{viewBox:"0 0 20.33 13.67",width:"20.33",height:"13.67",className:"ss-phone__glyph ss-phone__signal",children:[6.33,8.67,11,13.67].map((e,t)=>f("rect",{x:t*5.667,y:13.67-e,width:3.333,height:e,rx:1.667,fill:"currentColor"},t))})}function e1(){return f("svg",{viewBox:"0 0 19.33 14.33",width:"19.33",height:"14.33",className:"ss-phone__glyph ss-phone__wifi",children:f("path",{fillRule:"evenodd",fill:"currentColor",d:"M0.415933 5.54283C0.902185 6.04412 1.66017 5.95818 2.27513 5.41393C4.30595 3.58064 6.83731 2.63535 9.66901 2.63535C12.5007 2.63535 15.0464 3.60928 17.0629 5.41393C17.6636 5.97251 18.4215 6.0298 18.9221 5.54283C19.4226 5.02722 19.4942 4.2538 18.9793 3.70954C16.8341 1.51819 13.3302 0 9.66901 0C6.00783 0 2.48965 1.53251 0.358727 3.72387C-0.156127 4.2538 -0.0989213 5.02722 0.415933 5.55715L0.415933 5.54283ZM3.94841 9.13779C4.50617 9.68205 5.22124 9.62476 5.85051 9.10915C6.88022 8.29276 8.25316 7.73418 9.66901 7.7485C11.0706 7.7485 12.4435 8.29276 13.4875 9.12347C14.1168 9.63908 14.8605 9.66773 15.4039 9.12347C15.9331 8.57921 16.0189 7.7485 15.4611 7.23289C14.0739 5.98683 11.9859 5.11315 9.68332 5.11315C7.38077 5.11315 5.27845 5.98683 3.9055 7.23289C3.41925 7.69121 3.31914 8.47896 3.96271 9.13779L3.94841 9.13779ZM8.72511 13.8929C9.34008 14.4801 9.98365 14.4801 10.5986 13.8929L11.757 12.7757C12.372 12.1742 12.5007 11.4151 11.7999 10.8995C11.2136 10.4841 10.4699 10.212 9.66901 10.212C8.86813 10.212 8.11015 10.4841 7.53809 10.9138C6.83731 11.4151 6.98033 12.1885 7.59529 12.7757L8.73942 13.8929L8.72511 13.8929Z"})})}function t1(){return A("svg",{viewBox:"0 0 29.33 13.67",width:"29.33",height:"13.67",className:"ss-phone__glyph ss-phone__battery",children:[f("path",{fill:"currentColor",d:"M0 6.4C0 4.15979 0 3.03969 0.435974 2.18404C0.819467 1.43139 1.43139 0.819467 2.18404 0.435974C3.03969 0 4.15979 0 6.4 0L19.933 0C22.1732 0 23.2933 0 24.149 0.435974C24.9016 0.819467 25.5135 1.43139 25.897 2.18404C26.333 3.03969 26.333 4.15979 26.333 6.4L26.333 7.26666C26.333 9.50687 26.333 10.627 25.897 11.4826C25.5135 12.2353 24.9016 12.8472 24.149 13.2307C23.2933 13.6667 22.1732 13.6667 19.933 13.6667L6.4 13.6667C4.15979 13.6667 3.03969 13.6667 2.18404 13.2307C1.43139 12.8472 0.819467 12.2353 0.435974 11.4826C0 10.627 0 9.50687 0 7.26666L0 6.4Z"}),f("path",{fillRule:"evenodd",fill:"currentColor",transform:"translate(27.33 4.33)",d:"M0 0L0 5C0.601505 4.8625 2 3.75 2 2.5C2 1.25 0.601505 0.1375 0 0Z"})]})}ut();var Ip=document.createElement("style");Ip.textContent=`/* Collapse */

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
`;document.head.appendChild(Ip);function xt({open:e,reveal:t="clip",from:a="above",solid:n=!1,children:r,className:o,...s}){let[l,u]=pe(!1),[c,m]=pe(!1),g=Z(null),h=Z(!0);return lt(()=>{let L=g.current?.scrollHeight??0;if(L)m(L>44);if(h.current)return void(h.current=!1);u(!0);let x=setTimeout(()=>u(!1),900);return()=>clearTimeout(x)},[e]),f("div",{...s,className:`ss-collapse${o?` ${o}`:""}`,"data-open":e||void 0,"data-reveal":t,"data-solid":n||void 0,"data-from":t==="drop"?a:void 0,"data-moving":l||void 0,"data-tall":c||void 0,onTransitionEnd:(L)=>{if(L.target===L.currentTarget&&L.propertyName==="grid-template-rows")u(!1);s.onTransitionEnd?.(L)},children:f("div",{ref:g,className:"ss-collapse__inner","data-crop":t==="clip"||void 0,children:r})})}var kp=document.createElement("style");kp.textContent=`/* Icon */

@layer stageshow {
  .ss-icon {
    display: block;
    flex-shrink: 0;
  }
}
`;document.head.appendChild(kp);var Cp={check:Fr,plus:Ea,close:Jr,"chevron-right":Br,"chevron-down":zr,search:_a,globe:Nr,external:Ar,clock:Er,archive:br,trash:Zr,more:ia,arrow:Mr,file:Or,user:Qr,bell:Ba,card:_r,bolt:eo,lock:Hr,play:Gr,pause:Vr,faceid:jr,wifi:Yr,heart:qr,star:$r,calendar:Rr,mail:Wr,send:Kr,home:da,gear:Xr,grip:Ur},a1={chip:"M3.5 2.5h9a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4a1.5 1.5 0 0 1 1.5-1.5zM2 6h4M2 10h4M10 6h4M10 10h4M6 2.5v11M10 2.5v11M6 8h4",contactless:"M6.8 6.2a2.5 2.5 0 0 1 0 3.6M8.5 4.5a5 5 0 0 1 0 7M10.3 2.7a7.5 7.5 0 0 1 0 10.6"},n1={bolt:"M9.6 1.2 3.2 8.9a.6.6 0 0 0 .5 1H7.4l-1 4.9a.4.4 0 0 0 .7.3l6.4-7.7a.6.6 0 0 0-.5-1H9.3l1-4.9a.4.4 0 0 0-.7-.3Z",card:"M3 3h10a1.75 1.75 0 0 1 1.75 1.75V5.6H1.25v-.85A1.75 1.75 0 0 1 3 3Zm-1.75 4.4h13.5v3.85A1.75 1.75 0 0 1 13 13H3a1.75 1.75 0 0 1-1.75-1.75Zm2.25 2.6v1h3v-1Z",bell:"M8 1.25a4.25 4.25 0 0 0-4.25 4.25v3.1l-1.3 2.1a.6.6 0 0 0 .5.9h10.1a.6.6 0 0 0 .5-.9l-1.3-2.1V5.5A4.25 4.25 0 0 0 8 1.25ZM6.2 13.1a1.9 1.9 0 0 0 3.6 0Z",user:"M8 1.5a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2Zm0 7.4c3.1 0 5.4 1.8 5.9 4.6a.7.7 0 0 1-.7.8H2.8a.7.7 0 0 1-.7-.8C2.6 10.7 4.9 8.9 8 8.9Z",clock:"M8 1.25a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5Zm-.75 3v4.2l2.9 1.75.75-1.25-2.15-1.3V4.25Z",check:"M8 1.25a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5Zm3 4.3-.95-.8-3.3 3.95-1.85-1.8-.85.9 2.8 2.75Z",lock:"M8 1.25A3.25 3.25 0 0 0 4.75 4.5v2H4.5A1.5 1.5 0 0 0 3 8v5.25a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V8a1.5 1.5 0 0 0-1.5-1.5h-.25v-2A3.25 3.25 0 0 0 8 1.25Zm-1.75 5.25v-2a1.75 1.75 0 0 1 3.5 0v2Z",play:"M4.5 2.6v10.8a.8.8 0 0 0 1.2.7l8.6-5.4a.8.8 0 0 0 0-1.4L5.7 1.9a.8.8 0 0 0-1.2.7Z",pause:"M4 2.5h2.6a.6.6 0 0 1 .6.6v9.8a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V3.1a.6.6 0 0 1 .6-.6Zm5.4 0H12a.6.6 0 0 1 .6.6v9.8a.6.6 0 0 1-.6.6H9.4a.6.6 0 0 1-.6-.6V3.1a.6.6 0 0 1 .6-.6Z",heart:"M8 14.2c-.2 0-6.6-3.7-6.6-8.4a3.6 3.6 0 0 1 6.6-2 3.6 3.6 0 0 1 6.6 2c0 4.7-6.4 8.4-6.6 8.4Z",star:"M8 1.2a.6.6 0 0 1 .55.35l1.75 3.6 3.95.55a.6.6 0 0 1 .33 1.03l-2.86 2.8.68 3.94a.6.6 0 0 1-.87.63L8 12.25 4.47 14.1a.6.6 0 0 1-.87-.63l.68-3.94-2.86-2.8a.6.6 0 0 1 .33-1.03l3.95-.55 1.75-3.6A.6.6 0 0 1 8 1.2Z",home:"M7.5 1.6a.8.8 0 0 1 1 0l5.7 4.6a.8.8 0 0 1 .3.6v6.7a1 1 0 0 1-1 1H10V10.3H6v4.2H2.5a1 1 0 0 1-1-1V6.8a.8.8 0 0 1 .3-.6Z",gear:"M6.67 2.46L7.03 0.81L8.97 0.81L9.33 2.46L10.98 3.14L12.40 2.24L13.76 3.60L12.86 5.02L13.54 6.67L15.19 7.03L15.19 8.97L13.54 9.33L12.86 10.98L13.76 12.40L12.40 13.76L10.98 12.86L9.33 13.54L8.97 15.19L7.03 15.19L6.67 13.54L5.02 12.86L3.60 13.76L2.24 12.40L3.14 10.98L2.46 9.33L0.81 8.97L0.81 7.03L2.46 6.67L3.14 5.02L2.24 3.60L3.60 2.24L5.02 3.14ZM5.60 8.00a2.40 2.40 0 1 0 4.80 0a2.40 2.40 0 1 0 -4.80 0Z",calendar:"M3.5 2h9A2 2 0 0 1 14.5 4v8.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm-.5 4.5v6a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-6ZM4.2 7.6h1.6v1.6h-1.6ZM7.2 7.6h1.6v1.6h-1.6ZM10.2 7.6h1.6v1.6h-1.6ZM4.2 10.2h1.6v1.6h-1.6ZM7.2 10.2h1.6v1.6h-1.6ZM10.2 10.2h1.6v1.6h-1.6Z",send:"M14.3 1.7a.55.55 0 0 0-.6-.12L1.75 6.4a.55.55 0 0 0 0 1.02l4.6 1.85 4.9-4.13a.2.2 0 0 1 .28.28L7.4 10.3l1.84 4.6a.55.55 0 0 0 1.02 0l4.83-11.95a.55.55 0 0 0-.12-.6Z",mail:"M2.5 3h11A1.5 1.5 0 0 1 15 4.4L8 8.9 1 4.4A1.5 1.5 0 0 1 2.5 3ZM1 6.1v5.4A1.5 1.5 0 0 0 2.5 13h11a1.5 1.5 0 0 0 1.5-1.5V6.1l-6.6 4.2a.8.8 0 0 1-.8 0Z"};function Sp({name:e,size:t=16,stroke:a=1.5,filled:n,className:r,style:o}){let s=n?n1[e]:void 0,l=`ss-icon${r?` ${r}`:""}`;if(!s&&e in Cp){let u=Cp[e];return f(u,{size:t,strokeWidth:a,absoluteStrokeWidth:!0,className:l,style:o,"aria-hidden":!0})}return f("svg",{viewBox:"0 0 16 16",width:t,height:t,className:l,style:o,"aria-hidden":!0,children:s?f("path",{d:s,fill:"currentColor",fillRule:"evenodd"}):f("path",{d:a1[e],fill:"none",stroke:"currentColor",strokeWidth:a,strokeLinecap:"round",strokeLinejoin:"round"})})}ut();var Pp=document.createElement("style");Pp.textContent=`/* Check */

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
`;document.head.appendChild(Pp);function bp({on:e,pending:t,size:a=16,className:n,...r}){return f("span",{...r,className:`ss-check${n?` ${n}`:""}`,"data-on":e||void 0,"data-pending":t&&!e||void 0,style:{width:a,height:a,...r.style},children:A("svg",{viewBox:"0 0 16 16",width:a,height:a,"aria-hidden":!0,children:[f("circle",{className:"ss-check__ring",cx:"8",cy:"8",r:"7.25"}),f("circle",{className:"ss-check__arc",cx:"8",cy:"8",r:"7.25",pathLength:1}),f("circle",{className:"ss-check__fill",cx:"8",cy:"8",r:"8"}),f("path",{className:"ss-check__tick",d:"M4.5 8.2 7 10.6l4.6-5",pathLength:1})]})})}var Mp=document.createElement("style");Mp.textContent=`/* Spinner */

@layer stageshow {
  .ss-spinner {
    flex: none;
    animation: ss-spin 0.8s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .ss-spinner { animation: none; }
  }
}
`;document.head.appendChild(Mp);function Fs({size:e=14,className:t,style:a,...n}){return A("svg",{...n,className:`ss-spinner${t?` ${t}`:""}`,viewBox:"0 0 16 16",width:e,height:e,style:a,"aria-hidden":!0,children:[f("circle",{cx:"8",cy:"8",r:"6.25",fill:"none",stroke:"currentColor",strokeOpacity:"0.18",strokeWidth:"1.5"}),f("path",{d:"M8 1.75a6.25 6.25 0 0 1 6.25 6.25",fill:"none",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round"})]})}var Ap={sep:" ",actions:{send:"Send",edit:"Edit",skip:"Don't send",sent:"Sent"},tags:{review:"Needs review",sent:"Sent"},hero:{ask:["When a new mail arrives,","summarize it and draft a reply"],ack:["Got it.","I'll always ask before sending."],ackAt:"9:12 AM",mail:"New mail · Emily Carter · Next week's shoot",summary:["Emily Carter asked","whether Tuesday afternoon","next week works for the shoot."],summaryAt:"9:41 AM",draftFor:"Reply draft · Emily Carter",draftBody:["Tuesday at 2 PM works.","See you at the studio."],dock:["Send this reply","to Emily Carter?"],sentAt:"9:42 AM",composer:"Send a message"},phone:{time:"8:30",ask:"What's on my schedule today?",busy:"Checking",reply:"You have two events today.",events:[["10:00 AM","Weekly team meeting"],["1:30 PM","Dentist appointment"]]},watch:{item:"Camping chair",watching:"Watching",before:"$89",after:"$72",notices:"Notifications",changed:"Price changed",now:"Just now",keep:"Stay signed in",keepNote:"3 sites · No changes",keepAt:"8:00 AM"},video:{tagline:["A personal assistant that stays on,","on your own computer."],scenes:[{title:["Hand it a task,","get the result back"],sub:["Ask from your phone.","A session does the work and reports back."]},{title:["Nothing goes out","without your OK"],sub:["Replies wait in the chat","until you press Send."]},{title:["It keeps watch","while you are away"],sub:["Prices, logins and daily checks","reach you only as a quiet notice."]},{title:["Everything it did,","in one list"],sub:["The worklog keeps each result","one tap away."]}],hand:{ask:["Put this week's sales","into a report"],ackAt:"9:18 AM",ack:["Handed to a session.","I'll tell you when it's done."],task:"Weekly sales report",running:"Running",done:"Done",file:"weekly-sales.pdf",reportAt:"9:20 AM",report:["Done.","Sales rose 12% over last week.","The report is attached."]},mail:{chip:"New mail · Next week's shoot",summary:["A client asks","whether Tuesday afternoon next week","works for the shoot."],summaryAt:"9:41 AM",draftFor:"Reply draft",draftBody:["Tuesday at 2 PM works.","See you at the studio."],dock:["Send this reply?"],sentAt:"9:42 AM"},brief:{title:"Morning briefing",note:"2 events today · 1 reply waiting",at:"7:30 AM"},worklog:{title:"Worklog",rows:[["Price check · Camping chair","9:44 AM",""],["Replied to the shoot mail","9:42 AM",""],["Weekly sales report","9:20 AM","1 result"],["Morning briefing","7:30 AM",""]]}}},r1={sep:" ",actions:{send:"보내기",edit:"고치기",skip:"보내지 않기",sent:"보냈어요"},tags:{review:"확인 필요",sent:"보냈어요"},hero:{ask:["새 메일이 오면","요약하고 답장 초안 써 줘"],ack:["알겠어요.","보내기 전에 꼭 물어볼게요."],ackAt:"오전 9:12",mail:"새 메일 · 한지우 · 다음 주 촬영 일정",summary:["한지우 님이","다음 주 화요일 오후에","촬영이 되는지 물어봤어요."],summaryAt:"오전 9:41",draftFor:"답장 초안 · 한지우",draftBody:["화요일 오후 2시 좋아요.","성수 스튜디오에서 뵐게요."],dock:["한지우 님께","이 답장을 보낼까요?"],sentAt:"오전 9:42",composer:"메시지 보내기"},phone:{time:"8:30",ask:"오늘 일정 알려 줘",busy:"확인하는 중",reply:"오늘 일정은 두 개예요.",events:[["10:00","팀 주간 회의"],["13:30","치과 예약"]]},watch:{item:"캠핑 의자",watching:"지켜보는 중",before:"89,000원",after:"72,000원",notices:"알림",changed:"가격이 바뀌었어요",now:"방금",keep:"로그인 유지",keepNote:"사이트 세 곳 · 바뀐 것 없음",keepAt:"오전 8:00"},video:{tagline:["내 컴퓨터에서 항상 켜져 있는","개인 비서예요."],scenes:[{title:["맡기면","결과가 돌아와요"],sub:["폰으로 부탁하면","세션이 일하고 결과를 가져와요."]},{title:["내가 허락해야","나가요"],sub:["답장은 채팅에서","보내기를 누를 때까지 기다려요."]},{title:["자리를 비워도","지켜봐요"],sub:["가격, 로그인, 정해 둔 점검은","바뀔 때만 조용히 알려 줘요."]},{title:["한 일은","작업내역에 남아요"],sub:["결과 파일도","거기서 바로 열어요."]}],hand:{ask:["이번 주 매출을","보고서로 정리해 줘"],ackAt:"오전 9:18",ack:["세션에 맡겼어요.","끝나면 알려 드릴게요."],task:"주간 매출 보고서",running:"진행 중",done:"완료",file:"주간-매출.pdf",reportAt:"오전 9:20",report:["끝났어요.","지난주보다 매출이 12% 늘었어요.","보고서를 붙여 뒀어요."]},mail:{chip:"새 메일 · 다음 주 촬영 일정",summary:["고객이","다음 주 화요일 오후에","촬영이 되는지 물어봤어요."],summaryAt:"오전 9:41",draftFor:"답장 초안",draftBody:["화요일 오후 2시 좋아요.","스튜디오에서 뵐게요."],dock:["이 답장을 보낼까요?"],sentAt:"오전 9:42"},brief:{title:"아침 점검",note:"오늘 일정 2개 · 답장 1건 대기",at:"오전 7:30"},worklog:{title:"작업내역",rows:[["캠핑 의자 가격 확인","오전 9:44",""],["촬영 메일에 답장을 보냈어요","오전 9:42",""],["주간 매출 보고서","오전 9:20","결과 1"],["아침 점검","오전 7:30",""]]}}},o1={sep:"",actions:{send:"送信",edit:"編集",skip:"送信しない",sent:"送信しました"},tags:{review:"確認待ち",sent:"送信済み"},hero:{ask:["新しいメールが届いたら、","要約して返信の下書きを書いて"],ack:["わかりました。","送る前に必ず確認しますね。"],ackAt:"午前9:12",mail:"新着メール · 佐藤 美咲 · 来週の撮影日程",summary:["佐藤 美咲さんが、","来週火曜の午後に","撮影できるか聞いています。"],summaryAt:"午前9:41",draftFor:"返信の下書き · 佐藤 美咲",draftBody:["火曜の午後2時で大丈夫です。","スタジオでお会いしましょう。"],dock:["この返信を","佐藤 美咲さんに送りますか？"],sentAt:"午前9:42",composer:"メッセージを送信"},phone:{time:"8:30",ask:"今日の予定を教えて",busy:"確認中",reply:"今日の予定は2件です。",events:[["10:00","チーム定例会議"],["13:30","歯医者の予約"]]},watch:{item:"キャンプチェア",watching:"ウォッチ中",before:"8,900円",after:"7,200円",notices:"通知",changed:"価格が変わりました",now:"たった今",keep:"ログイン維持",keepNote:"サイト3件 · 変更なし",keepAt:"午前8:00"},video:{tagline:["自分のパソコンで動き続ける、","パーソナルアシスタント。"],scenes:[{title:["任せれば、","結果が返ってきます"],sub:["スマホから頼むと、","セッションが作業して報告します。"]},{title:["あなたがOKするまで、","何も送りません"],sub:["返信の下書きは","チャットで確認を待ちます。"]},{title:["席を外している間も","見ていてくれます"],sub:["価格やログイン、定期チェックは","変化があったときだけ静かに通知。"]},{title:["やったことは","作業履歴に残ります"],sub:["結果のファイルも","そこからすぐ開けます。"]}],hand:{ask:["今週の売上を","レポートにまとめて"],ackAt:"午前9:18",ack:["セッションに任せました。","終わったらお知らせします。"],task:"週間売上レポート",running:"実行中",done:"完了",file:"週間売上.pdf",reportAt:"午前9:20",report:["終わりました。","先週より売上が12%増えています。","レポートを添付しました。"]},mail:{chip:"新着メール · 来週の撮影日程",summary:["お客様が、","来週火曜の午後に","撮影できるか聞いています。"],summaryAt:"午前9:41",draftFor:"返信の下書き",draftBody:["火曜の午後2時で大丈夫です。","スタジオでお会いしましょう。"],dock:["この返信を送りますか？"],sentAt:"午前9:42"},brief:{title:"朝のブリーフィング",note:"今日の予定2件 · 返信待ち1件",at:"午前7:30"},worklog:{title:"作業履歴",rows:[["キャンプチェアの価格確認","午前9:44",""],["撮影メールに返信しました","午前9:42",""],["週間売上レポート","午前9:20","結果 1"],["朝のブリーフィング","午前7:30",""]]}}},s1={sep:"",actions:{send:"发送",edit:"修改",skip:"不发送",sent:"已发送"},tags:{review:"待确认",sent:"已发送"},hero:{ask:["来新邮件时，","帮我总结并起草回复"],ack:["好的。","发送之前我一定会先问你。"],ackAt:"上午9:12",mail:"新邮件 · 林悦 · 下周拍摄安排",summary:["林悦问","下周二下午","能不能拍摄。"],summaryAt:"上午9:41",draftFor:"回复草稿 · 林悦",draftBody:["周二下午两点可以。","我们在工作室见。"],dock:["要把这封回复","发给林悦吗？"],sentAt:"上午9:42",composer:"发送消息"},phone:{time:"8:30",ask:"告诉我今天的日程",busy:"正在查看",reply:"今天有两个日程。",events:[["10:00","团队周会"],["13:30","牙医预约"]]},watch:{item:"露营椅",watching:"关注中",before:"¥599",after:"¥469",notices:"通知",changed:"价格变了",now:"刚刚",keep:"保持登录",keepNote:"3 个网站 · 没有变化",keepAt:"上午8:00"},video:{tagline:["在你自己的电脑上","一直开着的个人助理。"],scenes:[{title:["交给它，","结果自己回来"],sub:["用手机吩咐一声，","会话去干活，完成后向你汇报。"]},{title:["没有你点头，","什么都不会发出去"],sub:["回复草稿会留在聊天里，","等你点发送。"]},{title:["你不在时，","它替你盯着"],sub:["价格、登录和定时检查，","有变化才悄悄通知你。"]},{title:["做过的事，","都留在工作记录里"],sub:["结果文件","也能直接从这里打开。"]}],hand:{ask:["把本周的销售数据","整理成报告"],ackAt:"上午9:18",ack:["已交给会话处理。","完成后我会告诉你。"],task:"每周销售报告",running:"进行中",done:"已完成",file:"每周销售.pdf",reportAt:"上午9:20",report:["完成了。","销售额比上周增长了 12%。","报告已附上。"]},mail:{chip:"新邮件 · 下周拍摄安排",summary:["客户问","下周二下午","能不能拍摄。"],summaryAt:"上午9:41",draftFor:"回复草稿",draftBody:["周二下午两点可以。","我们在工作室见。"],dock:["要发送这封回复吗？"],sentAt:"上午9:42"},brief:{title:"早间简报",note:"今天 2 个日程 · 1 封待回复",at:"上午7:30"},worklog:{title:"工作记录",rows:[["露营椅价格检查","上午9:44",""],["已回复拍摄邮件","上午9:42",""],["每周销售报告","上午9:20","结果 1"],["早间简报","上午7:30",""]]}}},l1={sep:" ",actions:{send:"Enviar",edit:"Editar",skip:"No enviar",sent:"Enviado"},tags:{review:"Por revisar",sent:"Enviado"},hero:{ask:["Cuando llegue un correo nuevo,","resúmelo y escribe un borrador de respuesta"],ack:["Entendido.","Siempre te preguntaré antes de enviar."],ackAt:"9:12",mail:"Correo nuevo · Lucía Fernández · Rodaje de la próxima semana",summary:["Lucía Fernández pregunta","si el martes por la tarde","de la próxima semana va bien para el rodaje."],summaryAt:"9:41",draftFor:"Borrador de respuesta · Lucía Fernández",draftBody:["El martes a las 14:00 me va bien.","Nos vemos en el estudio."],dock:["¿Enviar esta respuesta","a Lucía Fernández?"],sentAt:"9:42",composer:"Enviar un mensaje"},phone:{time:"8:30",ask:"¿Qué tengo hoy?",busy:"Comprobando",reply:"Hoy tienes dos eventos.",events:[["10:00","Reunión semanal del equipo"],["13:30","Cita con el dentista"]]},watch:{item:"Silla de camping",watching:"Vigilando",before:"89 €",after:"72 €",notices:"Notificaciones",changed:"El precio ha cambiado",now:"Ahora",keep:"Mantener sesión",keepNote:"3 sitios · Sin cambios",keepAt:"8:00"},video:{tagline:["Un asistente personal siempre activo","en tu propio ordenador."],scenes:[{title:["Se lo encargas","y vuelve con el resultado"],sub:["Pídeselo desde el móvil.","Una sesión trabaja y te lo entrega."]},{title:["Nada sale","sin tu visto bueno"],sub:["Las respuestas esperan en el chat","hasta que pulses Enviar."]},{title:["Vigila por ti","cuando no estás"],sub:["Precios, accesos y revisiones diarias","te llegan como un aviso discreto."]},{title:["Todo lo que hizo,","en una sola lista"],sub:["El historial guarda cada resultado","a un toque."]}],hand:{ask:["Prepara un informe","con las ventas de la semana"],ackAt:"9:18",ack:["Se lo he pasado a una sesión.","Te aviso cuando termine."],task:"Informe semanal de ventas",running:"En curso",done:"Listo",file:"ventas-semana.pdf",reportAt:"9:20",report:["Listo.","Las ventas subieron un 12 % respecto a la semana pasada.","Te adjunto el informe."]},mail:{chip:"Correo nuevo · Rodaje",summary:["Un cliente pregunta si","el martes que viene por la tarde","va bien para el rodaje."],summaryAt:"9:41",draftFor:"Borrador de respuesta",draftBody:["El martes a las 14:00 me va bien.","Nos vemos en el estudio."],dock:["¿Enviar esta respuesta?"],sentAt:"9:42"},brief:{title:"Resumen de la mañana",note:"2 eventos hoy · 1 respuesta pendiente",at:"7:30"},worklog:{title:"Historial",rows:[["Precio de la silla de camping","9:44",""],["Respuesta enviada sobre el rodaje","9:42",""],["Informe semanal de ventas","9:20","1 resultado"],["Resumen de la mañana","7:30",""]]}}},u1={en:Ap,ko:r1,ja:o1,"zh-cn":s1,es:l1};function ha(e=document.documentElement.lang){return u1[e.toLowerCase()]??Ap}var Tp=()=>window.matchMedia("(prefers-color-scheme: dark)");function to(){let[e,t]=pe(()=>Tp().matches);return kt(()=>{let a=Tp(),n=()=>t(a.matches);return a.addEventListener("change",n),()=>a.removeEventListener("change",n)},[]),e}function ga({children:e,className:t}){let{sep:a}=ha();return f("span",{className:t,children:e.map((n,r)=>A("span",{children:[r>0&&a,f("span",{className:"ph",children:n})]},r))})}function Rp({size:e=22}){return A("svg",{className:"dz-mark",viewBox:"3.5 3.5 17 17",width:e,height:e,"aria-hidden":!0,children:[f("circle",{cx:"7.4",cy:"7.4",r:"3.1"}),f("circle",{cx:"16.6",cy:"7.4",r:"1.9"}),f("circle",{cx:"7.4",cy:"16.6",r:"1.9"}),f("circle",{className:"dz-mark__dot",cx:"16.6",cy:"16.6",r:"3.1"})]})}function Fp({send:e,at:t,target:a="send"}){let{actions:n}=ha();return A("div",{className:"dz-acts-cell",children:[A("div",{className:"dz-acts","data-off":e==="done"||void 0,children:[A("span",{className:"dz-btn dz-btn--send","data-target":a,"data-cursor":"pointer",children:[f("span",{className:"dz-layer","data-on":e==="idle"||void 0,children:n.send}),f("span",{className:"dz-layer","data-on":e==="busy"||void 0,children:f(Fs,{size:14})})]}),f("span",{className:"dz-btn",children:n.edit}),f("span",{className:"dz-btn dz-btn--text",children:n.skip})]}),A("div",{className:"dz-sent","data-off":e!=="done"||void 0,children:[f(bp,{on:e==="done",size:16}),n.sent,f("span",{className:"dz-sent__time",children:t})]})]})}var zp=document.createElement("style");zp.textContent=`.hz-phone {
  position: absolute;
  top: 8px;
  left: 20px;
}

/* The phone's screen is 402pt wide and drawn at 300 / 426 of that; the zoom brings the chat's own px back to about 1:1. */
.hz-app {
  zoom: 1.36;
  display: flex;
  flex-direction: column;
  height: 100%;
  padding-bottom: 14px;
  color: var(--ink);
  font-size: 13px;
}

.dz-mark { flex: none; fill: var(--ink); }
.dz-mark__dot { fill: var(--accent); }

.hz-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 8px 0 10px;
  color: var(--body);
}
.hz-back { flex: none; color: var(--muted); }
.hz-bar h2 {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--ink);
  font-size: 19px;
  font-weight: 700;
  line-height: 28px;
  letter-spacing: -0.02em;
}
.hz-bell {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  color: var(--body);
}
.hz-bd {
  position: absolute;
  top: 0;
  right: 0;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--warn);
  color: var(--surface);
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
}

.hz-cv {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin: 0 8px;
  border-radius: var(--r-card);
  background: var(--surface);
  overflow: hidden;
}

.hz-thread {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 14px;
  min-height: 0;
  padding: 0 14px 10px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 36px);
  mask-image: linear-gradient(to bottom, transparent, #000 36px);
}
.hz-thread > * { will-change: transform; flex: none; }
.hz-thread .ss-collapse__inner { min-width: 0; }

.hz-msg { display: flex; flex-direction: column; gap: 4px; }
.hz-me { align-items: flex-end; }
.hz-mm { color: var(--muted); font-size: 12px; line-height: 16px; }
.hz-mm b { color: var(--ink); font-weight: 600; }
.hz-bub {
  max-width: 86%;
  padding: 9px 14px;
  border-radius: 18px 18px 6px 18px;
  background: var(--surface-2);
  color: var(--ink);
  font-size: 13.5px;
  line-height: 1.45;
}
.hz-text { color: var(--ink); font-size: 13.5px; line-height: 1.55; }
.hz-sys {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  max-width: 100%;
  width: fit-content;
  margin: 0 auto;
  padding: 4px 12px;
  border-radius: 12px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 12px;
  line-height: 16px;
}
.hz-sys > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hz-sys .ss-icon { flex: none; color: var(--accent); }

.hz-q {
  display: grid;
  gap: 6px;
  padding: 10px 14px;
  border-radius: 14px;
  background: var(--surface-2);
}
.hz-q__hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hz-q__hd .hz-mm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hz-q__body { color: var(--body); font-size: 13px; line-height: 1.55; }

.hz-dock {
  display: grid;
  gap: 10px;
  margin: 0 8px 6px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--surface-2);
}
.hz-dock__q { display: flex; align-items: center; gap: 8px; }
.hz-dock__t { color: var(--ink); font-size: 14px; font-weight: 600; line-height: 1.4; }
.hz-dock .dz-btn { padding: 0 11px; }
.hz-dock .dz-btn--text { padding: 0 6px; }
.hz-dock .dz-btn:not(.dz-btn--send):not(.dz-btn--text) { background: var(--surface); }

.hz-cmp { flex: none; padding: 4px 8px 8px; }
.hz-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 42px;
  padding: 0 6px 0 14px;
  border-radius: 18px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 14px;
}
.hz-ph { flex: 1; min-width: 0; }
.hz-send {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--line-strong);
  color: var(--surface);
}

/* The status bar takes the page's ink, so it follows the same scheme as everything drawn on the screen. */
.hz-phone .ss-phone__screen { color: var(--ink); }
`;document.head.appendChild(zp);var i1={mail:!1,summary:!1,draft:!1,dock:!1,send:"idle"},d1={mail:!0,summary:!0,draft:!0,dock:!1,send:"done"};async function f1(e){await e.wait(700),e.put({mail:!0}),await e.wait(1100),e.put({summary:!0}),await e.wait(1300),e.put({draft:!0,dock:!0}),await e.wait(1500),await e.click({at:"send",x:0.55,y:0.6}),e.put({send:"busy"}),await e.wait(800),e.put({send:"done"}),await e.wait(900),e.put({dock:!1}),await e.wait(2000),e.put({draft:!1}),await e.wait(70),e.put({summary:!1}),await e.wait(70),e.put({mail:!1}),await e.wait(700),e.put({send:"idle"})}var Dp={width:340,height:676},c1=300,Bp=(e,t)=>e.split(" · ").slice(0,t).join(" · ");function ci(){let e=to(),{hero:t,tags:a}=ha();return f(Ts,{className:"dz hz",width:Dp.width,height:Dp.height,fill:!0,theme:e?"dark":"light",initial:i1,poster:d1,script:f1,play:"loop",cursor:{at:{x:250,y:560},style:"touch"},children:(n)=>f(Rs,{width:c1,frame:"pro",time:"9:41",dark:e,wallpaper:"var(--bg)",className:"hz-phone",children:A("div",{className:"hz-app",children:[A("div",{className:"hz-bar",children:[f(Dr,{className:"hz-back",size:20,"aria-hidden":!0}),f("h2",{children:"dotz"}),f(_a,{size:17,strokeWidth:1.75,"aria-hidden":!0}),A("span",{className:"hz-bell",children:[f(Ba,{size:18,strokeWidth:1.75,"aria-hidden":!0}),f("span",{className:"hz-bd",children:"1"})]})]}),A("div",{className:"hz-cv",children:[A("div",{className:"hz-thread",children:[f("div",{className:"hz-msg hz-me",children:f("span",{className:"hz-bub",children:f(ga,{children:t.ask})})}),A("div",{className:"hz-msg",children:[A("span",{className:"hz-mm",children:[f("b",{children:"dotz"})," · ",t.ackAt]}),f(ga,{className:"hz-text",children:t.ack})]}),f(xt,{open:n.mail,reveal:"drop",from:"below",children:A("div",{className:"hz-sys",children:[f(Sp,{name:"mail",size:13}),f("span",{children:Bp(t.mail,2)})]})}),f(xt,{open:n.summary,reveal:"drop",from:"below",children:A("div",{className:"hz-msg",children:[A("span",{className:"hz-mm",children:[f("b",{children:"dotz"})," · ",t.summaryAt]}),f(ga,{className:"hz-text",children:t.summary})]})}),f(xt,{open:n.draft,reveal:"drop",from:"below",children:A("div",{className:"hz-q",children:[A("div",{className:"hz-q__hd",children:[f("span",{className:"hz-mm",children:Bp(t.draftFor,1)}),A("span",{className:"dz-swap",children:[f("span",{className:"dz-tag dz-tag--warn","data-off":n.send==="done"||void 0,children:a.review}),f("span",{className:"dz-tag dz-tag--ok","data-off":n.send!=="done"||void 0,children:a.sent})]})]}),f(ga,{className:"hz-q__body",children:t.draftBody})]})})]}),f(xt,{open:n.dock,reveal:"drop",from:"below",children:A("div",{className:"hz-dock",children:[A("div",{className:"hz-dock__q",children:[f("span",{className:"dz-tag dz-tag--warn",children:a.review}),f(ga,{className:"hz-dock__t",children:t.dock})]}),f(Fp,{send:n.send,at:t.sentAt})]})}),f("div",{className:"hz-cmp",children:A("div",{className:"hz-box",children:[f(Ea,{size:18,strokeWidth:1.75,"aria-hidden":!0}),f("span",{className:"hz-ph",children:t.composer}),f("span",{className:"hz-send",children:f(Tr,{size:16,strokeWidth:2,"aria-hidden":!0})})]})})]})]})})})}var Ep=document.createElement("style");Ep.textContent=`.cz .ss-stage { overflow: hidden; }

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
  border-radius: var(--r-card);
  background: var(--surface);
  color: var(--ink);
  font-size: 13px;
}
.cz-panel--bare { gap: 10px; background: transparent; padding: 14px 0 14px 4px; }
.cz-panel > * { flex: none; will-change: transform; }

.cz-meta { color: var(--muted); font-size: 12px; }
.cz-meta b { color: var(--ink); font-weight: 600; }
.cz-tag {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 12px;
  font-weight: 500;
}
.cz-text { display: block; color: var(--ink); font-size: 14px; line-height: 1.55; }
.cz-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}
.cz-list {
  display: grid;
  max-width: 400px;
  border-radius: 14px;
  background: var(--surface-2);
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

.cz-phone { margin-top: 4px; }
/* the kit draws a phone screen in iPhone points and scales it down to 304px */
.cz-chat { zoom: 1.55; display: flex; flex-direction: column; gap: 8px; padding: 0 10px; color: var(--ink); font-size: 13px; }
.cz-chat__hd { display: flex; align-items: center; justify-content: center; gap: 6px; padding-bottom: 4px; font-size: 13px; }
.cz-chat__hd b { font-weight: 600; }
.cz-chat .cz-text { font-size: 13px; }
.cz-chat .cz-ev { height: 30px; grid-template-columns: 44px 1fr; padding: 0 10px; }
.cz-chat .cz-ev__t { font-size: 12px; }
.cz-chat .cz-ev__title { font-size: 12.5px; }
.cz-me { display: flex; justify-content: flex-end; }
.cz-me > span {
  padding: 7px 12px;
  border-radius: 16px 16px 6px 16px;
  background: var(--surface-2);
  font-size: 13px;
  line-height: 1.45;
}
.cz-busy { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }

.cz-watch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  max-width: 440px;
  padding: 10px 16px;
  border-radius: 14px;
  background: var(--surface);
}
.cz-watch .cz-nt__b b { font-weight: 600; }
.cz-amt { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.cz-amt em { font-style: normal; color: var(--accent-ink); }

.cz-nts { display: grid; max-width: 440px; border-radius: var(--r-card); background: var(--surface); overflow: hidden; }
.cz-nts > :not(:first-child) .cz-nt,
.cz-nts > .cz-nt:not(:first-child) { border-top: 1px solid var(--line); }
.cz-nt {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
  padding: 9px 16px;
}
.cz-nt__dot { width: 8px; height: 8px; margin-top: 7px; border-radius: 50%; background: var(--line-strong); }
.cz-nt[data-unread] .cz-nt__dot { background: var(--accent); }
.cz-nt__b { display: grid; gap: 2px; min-width: 0; }
.cz-nt__b b { font-weight: 500; font-size: 14px; line-height: 22px; }
.cz-nt[data-unread] .cz-nt__b b { font-weight: 700; }
.cz-nt__b > span { color: var(--body); font-size: 12px; line-height: 16px; white-space: nowrap; }
.cz-nt__time { color: var(--muted); font-size: 12px; line-height: 22px; white-space: nowrap; }
.cz-price s { color: var(--muted); }
.cz-price em { font-style: normal; font-weight: 600; color: var(--accent-ink); }

.cz .ss-stage[data-layout='compact'] .cz-panel {
  top: 18px;
  left: 16px;
  /* still bleeds off the right edge, but its content ends inside the 350px stage */
  width: 360px;
  padding: 16px 40px 16px 16px;
}

.cz.cz--phone .ss-stage .cz-panel { top: 0; left: 0; width: 100%; height: 100%; align-items: center; padding: 0; background: transparent; }

/* The status bar takes the page's ink, so it follows the same scheme as everything drawn on the screen. */
.cz-phone .ss-phone__screen { color: var(--ink); }
`;document.head.appendChild(Ep);function _p({name:e,initial:t,poster:a,script:n,bare:r,children:o}){let s=to();return f(Ts,{className:`dz cz cz--${e}`,width:520,height:280,compact:{below:440,width:350,height:270},theme:s?"dark":"light",initial:t,poster:a,script:n,play:"loop",fill:!0,children:(l)=>f("div",{className:`cz-panel${r?" cz-panel--bare":""}`,children:o(l)})})}function Op(){let e=to(),t=ha().phone,a=t.events;return f(_p,{name:"phone",bare:!0,initial:{ask:!1,busy:!1,reply:!1,rows:0},poster:{ask:!0,busy:!1,reply:!0,rows:2},script:async(n)=>{await n.wait(500),n.put({ask:!0}),await n.wait(700),n.put({busy:!0}),await n.wait(1300),n.put({busy:!1,reply:!0}),await n.wait(500);for(let r=1;r<=a.length;r++)n.put({rows:r}),await n.wait(260);await n.wait(3000),n.put({rows:0}),await n.wait(70),n.put({reply:!1}),await n.wait(70),n.put({ask:!1}),await n.wait(600)},children:(n)=>f(Rs,{width:304,frame:"bezel",time:t.time,dark:e,wallpaper:"var(--surface)",className:"cz-phone",children:A("div",{className:"cz-chat",children:[A("div",{className:"cz-chat__hd",children:[f(Rp,{size:18}),f("b",{children:"dotz"})]}),f(xt,{open:n.ask,reveal:"drop",from:"below",children:f("div",{className:"cz-me",children:f("span",{children:t.ask})})}),f(xt,{open:n.busy,children:A("div",{className:"cz-busy",children:[f(Fs,{size:12}),t.busy]})}),f(xt,{open:n.reply,reveal:"drop",from:"below",children:f(ga,{className:"cz-text",children:[t.reply]})}),f("div",{className:"cz-list",children:a.map(([r,o],s)=>f(xt,{open:n.rows>s,children:A("div",{className:"cz-ev",children:[f("span",{className:"cz-ev__t",children:r}),f("span",{className:"cz-ev__title",children:o})]})},r))})]})})})}function Np(){let e=ha().watch;return f(_p,{name:"watch",bare:!0,initial:{drop:!1,alert:!1},poster:{drop:!0,alert:!0},script:async(t)=>{await t.wait(1100),t.put({drop:!0}),await t.wait(1100),t.put({alert:!0}),await t.wait(3400),t.put({alert:!1}),await t.wait(200),t.put({drop:!1}),await t.wait(600)},children:(t)=>A(Oa,{children:[A("div",{className:"cz-watch",children:[A("span",{className:"cz-nt__b",children:[f("b",{children:e.item}),f("span",{children:e.watching})]}),f("span",{className:"cz-amt",children:A("span",{className:"dz-swap",children:[f("span",{"data-off":t.drop||void 0,children:e.before}),f("em",{"data-off":!t.drop||void 0,children:e.after})]})})]}),f("div",{className:"cz-title",children:e.notices}),A("div",{className:"cz-nts",children:[f(xt,{open:t.alert,reveal:"drop",children:A("div",{className:"cz-nt","data-unread":!0,children:[f("span",{className:"cz-nt__dot"}),A("span",{className:"cz-nt__b",children:[f("b",{children:e.changed}),A("span",{className:"cz-price",children:[e.item," ",f("s",{children:e.before})," → ",f("em",{children:e.after})]})]}),f("span",{className:"cz-nt__time",children:e.now})]})}),A("div",{className:"cz-nt",children:[f("span",{className:"cz-nt__dot"}),A("span",{className:"cz-nt__b",children:[f("b",{children:e.keep}),f("span",{children:e.keepNote})]}),f("span",{className:"cz-nt__time",children:e.keepAt})]})]})]})})}var p1={hero:ci,phone:Op,watch:Np},m1=(e)=>{let t=p1[e.dataset.ss??""];if(!t)return;Up.createRoot(e).render(f(t,{})),e.closest(".shot, .card")?.classList.add("ss-live")},qp=new IntersectionObserver((e)=>{for(let t of e){if(!t.isIntersecting)continue;qp.unobserve(t.target),m1(t.target)}},{rootMargin:"300px 0px"});for(let e of document.querySelectorAll("[data-ss]"))qp.observe(e);
