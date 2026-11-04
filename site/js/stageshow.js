var nm=Object.create;var{getPrototypeOf:rm,defineProperty:Mi,getOwnPropertyNames:om}=Object;var _i=Object.prototype.hasOwnProperty;function sm(e){return this[e]}var lm,um,Ai=(e,a,t)=>{var n=e!=null&&typeof e==="object";if(n){var r=a?lm??=new WeakMap:um??=new WeakMap,o=r.get(e);if(o)return o}t=e!=null?nm(rm(e)):{};let s=a||!e||!e.__esModule||!_i.call(e,"default")?Mi(t,"default",{value:e,enumerable:!0}):t;if(e&&typeof e==="object"||typeof e==="function"){for(let l of om(e))if(!_i.call(s,l))Mi(s,l,{get:sm.bind(e,l),enumerable:!0})}if(n)r.set(e,s);return s};var zi=(e,a)=>()=>(a||e((a={exports:{}}).exports,a),a.exports);var Xs=(e,a,t)=>()=>{if(e)try{a=e(e=0)}catch(n){t=[n]}if(t)throw t[0];return a};function Mn(e,a,t){this.props=e,this.context=a,this.refs=Ri,this.updater=t||Ti}function Fi(){}function Di(e,a,t){this.props=e,this.context=a,this.refs=Ri,this.updater=t||Ti}function gm(e,a,t){var n,r={},o=null,s=null;if(a!=null)for(n in a.ref!==void 0&&(s=a.ref),a.key!==void 0&&(o=""+a.key),a)mm.call(a,n)&&!hm.hasOwnProperty(n)&&(r[n]=a[n]);var l=arguments.length-2;if(l===1)r.children=t;else if(1<l){for(var u=Array(l),c=0;c<l;c++)u[c]=arguments[c+2];r.children=u}if(e&&e.defaultProps)for(n in l=e.defaultProps,l)r[n]===void 0&&(r[n]=l[n]);return{$$typeof:im,type:e,key:o,ref:s,props:r,_owner:Bi.current}}var im,dm,fm,cm,Ti,pm,Ri,Zs,mm,Bi,hm,Fa,xm,wm,_n,An=function(e){return e={$$typeof:fm,_currentValue:e,_currentValue2:e,_threadCount:0,Provider:null,Consumer:null,_defaultValue:null,_globalName:null},e.Provider={$$typeof:dm,_context:e},e.Consumer=e},Gt,zn=function(e){return{$$typeof:cm,render:e}},Da=function(e,a){return Fa.current.useCallback(e,a)},Tn=function(e){return Fa.current.useContext(e)},Ca=function(e,a){return Fa.current.useEffect(e,a)},Qs=function(){return Fa.current.useId()},ua=function(e,a){return Fa.current.useLayoutEffect(e,a)},po=function(e,a){return Fa.current.useMemo(e,a)},Z=function(e){return Fa.current.useRef(e)},pe=function(e){return Fa.current.useState(e)};var ia=Xs(()=>{im=Symbol.for("react.element"),dm=Symbol.for("react.provider"),fm=Symbol.for("react.context"),cm=Symbol.for("react.forward_ref"),Ti={isMounted:function(){return!1},enqueueForceUpdate:function(){},enqueueReplaceState:function(){},enqueueSetState:function(){}},pm=Object.assign,Ri={};Mn.prototype.isReactComponent={};Mn.prototype.setState=function(e,a){if(typeof e!=="object"&&typeof e!=="function"&&e!=null)throw Error("setState(...): takes an object of state variables to update or a function which returns an object of state variables.");this.updater.enqueueSetState(this,e,a,"setState")};Mn.prototype.forceUpdate=function(e){this.updater.enqueueForceUpdate(this,e,"forceUpdate")};Fi.prototype=Mn.prototype;Zs=Di.prototype=new Fi;Zs.constructor=Di;pm(Zs,Mn.prototype);Zs.isPureReactComponent=!0;mm=Object.prototype.hasOwnProperty,Bi={current:null},hm={key:!0,ref:!0,__self:!0,__source:!0};Fa={current:null},xm={transition:null},wm={ReactCurrentDispatcher:Fa,ReactCurrentBatchConfig:xm,ReactCurrentOwner:Bi};_n=wm,Gt=gm});var Vi=zi(function($t){function Js(e,a){var t=e.length;e.push(a);e:for(;0<t;){var n=t-1>>>1,r=e[n];if(0<mo(r,a))e[n]=a,e[t]=r,t=n;else break e}}function da(e){return e.length===0?null:e[0]}function wo(e){if(e.length===0)return null;var a=e[0],t=e.pop();if(t!==a){e[0]=t;e:for(var n=0,r=e.length,o=r>>>1;n<o;){var s=2*(n+1)-1,l=e[s],u=s+1,c=e[u];if(0>mo(l,t))u<r&&0>mo(c,l)?(e[n]=c,e[u]=t,n=u):(e[n]=l,e[s]=t,n=s);else if(u<r&&0>mo(c,t))e[n]=c,e[u]=t,n=u;else break e}}return a}function mo(e,a){var t=e.sortIndex-a.sortIndex;return t!==0?t:e.id-a.id}if(typeof performance==="object"&&typeof performance.now==="function")el=performance,$t.unstable_now=function(){return el.now()};else ho=Date,al=ho.now(),$t.unstable_now=function(){return ho.now()-al};var el,ho,al,Sa=[],Ga=[],Lm=1,Ye=null,_e=3,Lo=!1,yt=!1,Fn=!1,Oi=typeof setTimeout==="function"?setTimeout:null,Ui=typeof clearTimeout==="function"?clearTimeout:null,Ni=typeof setImmediate<"u"?setImmediate:null;typeof navigator<"u"&&navigator.scheduling!==void 0&&navigator.scheduling.isInputPending!==void 0&&navigator.scheduling.isInputPending.bind(navigator.scheduling);function tl(e){for(var a=da(Ga);a!==null;){if(a.callback===null)wo(Ga);else if(a.startTime<=e)wo(Ga),a.sortIndex=a.expirationTime,Js(Sa,a);else break;a=da(Ga)}}function rl(e){if(Fn=!1,tl(e),!yt)if(da(Sa)!==null)yt=!0,sl(ol);else{var a=da(Ga);a!==null&&ll(rl,a.startTime-e)}}function ol(e,a){yt=!1,Fn&&(Fn=!1,Ui(Dn),Dn=-1),Lo=!0;var t=_e;try{tl(a);for(Ye=da(Sa);Ye!==null&&(!(Ye.expirationTime>a)||e&&!Wi());){var n=Ye.callback;if(typeof n==="function"){Ye.callback=null,_e=Ye.priorityLevel;var r=n(Ye.expirationTime<=a);a=$t.unstable_now(),typeof r==="function"?Ye.callback=r:Ye===da(Sa)&&wo(Sa),tl(a)}else wo(Sa);Ye=da(Sa)}if(Ye!==null)var o=!0;else{var s=da(Ga);s!==null&&ll(rl,s.startTime-a),o=!1}return o}finally{Ye=null,_e=t,Lo=!1}}var yo=!1,go=null,Dn=-1,Hi=5,qi=-1;function Wi(){return $t.unstable_now()-qi<Hi?!1:!0}function Ys(){if(go!==null){var e=$t.unstable_now();qi=e;var a=!0;try{a=go(!0,e)}finally{a?Rn():(yo=!1,go=null)}}else yo=!1}var Rn;if(typeof Ni==="function")Rn=function(){Ni(Ys)};else if(typeof MessageChannel<"u")xo=new MessageChannel,nl=xo.port2,xo.port1.onmessage=Ys,Rn=function(){nl.postMessage(null)};else Rn=function(){Oi(Ys,0)};var xo,nl;function sl(e){go=e,yo||(yo=!0,Rn())}function ll(e,a){Dn=Oi(function(){e($t.unstable_now())},a)}$t.unstable_IdlePriority=5;$t.unstable_ImmediatePriority=1;$t.unstable_LowPriority=4;$t.unstable_NormalPriority=3;$t.unstable_Profiling=null;$t.unstable_UserBlockingPriority=2;$t.unstable_cancelCallback=function(e){e.callback=null};$t.unstable_continueExecution=function(){yt||Lo||(yt=!0,sl(ol))};$t.unstable_forceFrameRate=function(e){0>e||125<e?console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"):Hi=0<e?Math.floor(1000/e):5};$t.unstable_getCurrentPriorityLevel=function(){return _e};$t.unstable_getFirstCallbackNode=function(){return da(Sa)};$t.unstable_next=function(e){switch(_e){case 1:case 2:case 3:var a=3;break;default:a=_e}var t=_e;_e=a;try{return e()}finally{_e=t}};$t.unstable_pauseExecution=function(){};$t.unstable_requestPaint=function(){};$t.unstable_runWithPriority=function(e,a){switch(e){case 1:case 2:case 3:case 4:case 5:break;default:e=3}var t=_e;_e=e;try{return a()}finally{_e=t}};$t.unstable_scheduleCallback=function(e,a,t){var n=$t.unstable_now();switch(typeof t==="object"&&t!==null?(t=t.delay,t=typeof t==="number"&&0<t?n+t:n):t=n,e){case 1:var r=-1;break;case 2:r=250;break;case 5:r=1073741823;break;case 4:r=1e4;break;default:r=5000}return r=t+r,e={id:Lm++,callback:a,priorityLevel:e,startTime:t,expirationTime:r,sortIndex:-1},t>n?(e.sortIndex=t,Js(Ga,e),da(Sa)===null&&e===da(Ga)&&(Fn?(Ui(Dn),Dn=-1):Fn=!0,ll(rl,t-n))):(e.sortIndex=r,Js(Sa,e),yt||Lo||(yt=!0,sl(ol))),e};$t.unstable_shouldYield=Wi;$t.unstable_wrapCallback=function(e){var a=_e;return function(){var t=_e;_e=a;try{return e.apply(this,arguments)}finally{_e=t}}}});function S(e){for(var a="https://reactjs.org/docs/error-decoder.html?invariant="+e,t=1;t<arguments.length;t++)a+="&args[]="+encodeURIComponent(arguments[t]);return"Minified React error #"+e+"; visit "+a+" for the full message or use the non-minified dev environment for full errors and additional helpful warnings."}function Rt(e,a){pn(e,a),pn(e+"Capture",a)}function pn(e,a){ur[e]=a;for(e=0;e<a.length;e++)Kd.add(a[e])}function Om(e){if(_l.call(ji,e))return!0;if(_l.call(Gi,e))return!1;if(Nm.test(e))return ji[e]=!0;return Gi[e]=!0,!1}function Um(e,a,t,n){if(t!==null&&t.type===0)return!1;switch(typeof a){case"function":case"symbol":return!0;case"boolean":if(n)return!1;if(t!==null)return!t.acceptsBooleans;return e=e.toLowerCase().slice(0,5),e!=="data-"&&e!=="aria-";default:return!1}}function Hm(e,a,t,n){if(a===null||typeof a>"u"||Um(e,a,t,n))return!0;if(n)return!1;if(t!==null)switch(t.type){case 3:return!a;case 4:return a===!1;case 5:return isNaN(a);case 6:return isNaN(a)||1>a}return!1}function Ne(e,a,t,n,r,o,s){this.acceptsBooleans=a===2||a===3||a===4,this.attributeName=n,this.attributeNamespace=r,this.mustUseProperty=t,this.propertyName=e,this.type=a,this.sanitizeURL=o,this.removeEmptyString=s}function Cu(e){return e[1].toUpperCase()}function Su(e,a,t,n){var r=Me.hasOwnProperty(a)?Me[a]:null;if(r!==null?r.type!==0:n||!(2<a.length)||a[0]!=="o"&&a[0]!=="O"||a[1]!=="n"&&a[1]!=="N")Hm(a,t,r,n)&&(t=null),n||r===null?Om(a)&&(t===null?e.removeAttribute(a):e.setAttribute(a,""+t)):r.mustUseProperty?e[r.propertyName]=t===null?r.type===3?!1:"":t:(a=r.attributeName,n=r.attributeNamespace,t===null?e.removeAttribute(a):(r=r.type,t=r===3||r===4&&t===!0?"":""+t,n?e.setAttributeNS(n,a,t):e.setAttribute(a,t)))}function Bn(e){if(e===null||typeof e!=="object")return null;return e=$i&&e[$i]||e["@@iterator"],typeof e==="function"?e:null}function Vn(e){if(ul===void 0)try{throw Error()}catch(t){var a=t.stack.trim().match(/\n( *(at )?)/);ul=a&&a[1]||""}return`
`+ul+e}function dl(e,a){if(!e||il)return"";il=!0;var t=Error.prepareStackTrace;Error.prepareStackTrace=void 0;try{if(a)if(a=function(){throw Error()},Object.defineProperty(a.prototype,"props",{set:function(){throw Error()}}),typeof Reflect==="object"&&Reflect.construct){try{Reflect.construct(a,[])}catch(c){var n=c}Reflect.construct(e,[],a)}else{try{a.call()}catch(c){n=c}e.call(a.prototype)}else{try{throw Error()}catch(c){n=c}e()}}catch(c){if(c&&n&&typeof c.stack==="string"){for(var r=c.stack.split(`
`),o=n.stack.split(`
`),s=r.length-1,l=o.length-1;1<=s&&0<=l&&r[s]!==o[l];)l--;for(;1<=s&&0<=l;s--,l--)if(r[s]!==o[l]){if(s!==1||l!==1)do if(s--,l--,0>l||r[s]!==o[l]){var u=`
`+r[s].replace(" at new "," at ");return e.displayName&&u.includes("<anonymous>")&&(u=u.replace("<anonymous>",e.displayName)),u}while(1<=s&&0<=l);break}}}finally{il=!1,Error.prepareStackTrace=t}return(e=e?e.displayName||e.name:"")?Vn(e):""}function qm(e){switch(e.tag){case 5:return Vn(e.type);case 16:return Vn("Lazy");case 13:return Vn("Suspense");case 19:return Vn("SuspenseList");case 0:case 2:case 15:return e=dl(e.type,!1),e;case 11:return e=dl(e.type.render,!1),e;case 1:return e=dl(e.type,!0),e;default:return""}}function Rl(e){if(e==null)return null;if(typeof e==="function")return e.displayName||e.name||null;if(typeof e==="string")return e;switch(e){case Zt:return"Fragment";case Wn:return"Portal";case Al:return"Profiler";case bu:return"StrictMode";case zl:return"Suspense";case Tl:return"SuspenseList"}if(typeof e==="object")switch(e.$$typeof){case Zd:return(e.displayName||"Context")+".Consumer";case Xd:return(e._context.displayName||"Context")+".Provider";case Pu:var a=e.render;return e=e.displayName,e||(e=a.displayName||a.name||"",e=e!==""?"ForwardRef("+e+")":"ForwardRef"),e;case Mu:return a=e.displayName||null,a!==null?a:Rl(e.type)||"Memo";case $a:a=e._payload,e=e._init;try{return Rl(e(a))}catch(t){}}return null}function Wm(e){var a=e.type;switch(e.tag){case 24:return"Cache";case 9:return(a.displayName||"Context")+".Consumer";case 10:return(a._context.displayName||"Context")+".Provider";case 18:return"DehydratedFragment";case 11:return e=a.render,e=e.displayName||e.name||"",a.displayName||(e!==""?"ForwardRef("+e+")":"ForwardRef");case 7:return"Fragment";case 5:return a;case 4:return"Portal";case 3:return"Root";case 6:return"Text";case 16:return Rl(a);case 8:return a===bu?"StrictMode":"Mode";case 22:return"Offscreen";case 12:return"Profiler";case 21:return"Scope";case 13:return"Suspense";case 19:return"SuspenseList";case 25:return"TracingMarker";case 1:case 0:case 17:case 2:case 14:case 15:if(typeof a==="function")return a.displayName||a.name||null;if(typeof a==="string")return a}return null}function lt(e){switch(typeof e){case"boolean":case"number":case"string":case"undefined":return e;case"object":return e;default:return""}}function Yd(e){var a=e.type;return(e=e.nodeName)&&e.toLowerCase()==="input"&&(a==="checkbox"||a==="radio")}function Vm(e){var a=Yd(e)?"checked":"value",t=Object.getOwnPropertyDescriptor(e.constructor.prototype,a),n=""+e[a];if(!e.hasOwnProperty(a)&&typeof t<"u"&&typeof t.get==="function"&&typeof t.set==="function"){var{get:r,set:o}=t;return Object.defineProperty(e,a,{configurable:!0,get:function(){return r.call(this)},set:function(s){n=""+s,o.call(this,s)}}),Object.defineProperty(e,a,{enumerable:t.enumerable}),{getValue:function(){return n},setValue:function(s){n=""+s},stopTracking:function(){e._valueTracker=null,delete e[a]}}}}function Io(e){e._valueTracker||(e._valueTracker=Vm(e))}function Jd(e){if(!e)return!1;var a=e._valueTracker;if(!a)return!0;var t=a.getValue(),n="";return e&&(n=Yd(e)?e.checked?"true":"false":e.value),e=n,e!==t?(a.setValue(e),!0):!1}function $o(e){if(e=e||(typeof document<"u"?document:void 0),typeof e>"u")return null;try{return e.activeElement||e.body}catch(a){return e.body}}function Fl(e,a){var t=a.checked;return le({},a,{defaultChecked:void 0,defaultValue:void 0,value:void 0,checked:t!=null?t:e._wrapperState.initialChecked})}function Ki(e,a){var t=a.defaultValue==null?"":a.defaultValue,n=a.checked!=null?a.checked:a.defaultChecked;t=lt(a.value!=null?a.value:t),e._wrapperState={initialChecked:n,initialValue:t,controlled:a.type==="checkbox"||a.type==="radio"?a.checked!=null:a.value!=null}}function ef(e,a){a=a.checked,a!=null&&Su(e,"checked",a,!1)}function Dl(e,a){ef(e,a);var t=lt(a.value),n=a.type;if(t!=null)if(n==="number"){if(t===0&&e.value===""||e.value!=t)e.value=""+t}else e.value!==""+t&&(e.value=""+t);else if(n==="submit"||n==="reset"){e.removeAttribute("value");return}a.hasOwnProperty("value")?Bl(e,a.type,t):a.hasOwnProperty("defaultValue")&&Bl(e,a.type,lt(a.defaultValue)),a.checked==null&&a.defaultChecked!=null&&(e.defaultChecked=!!a.defaultChecked)}function Xi(e,a,t){if(a.hasOwnProperty("value")||a.hasOwnProperty("defaultValue")){var n=a.type;if(!(n!=="submit"&&n!=="reset"||a.value!==void 0&&a.value!==null))return;a=""+e._wrapperState.initialValue,t||a===e.value||(e.value=a),e.defaultValue=a}t=e.name,t!==""&&(e.name=""),e.defaultChecked=!!e._wrapperState.initialChecked,t!==""&&(e.name=t)}function Bl(e,a,t){if(a!=="number"||$o(e.ownerDocument)!==e)t==null?e.defaultValue=""+e._wrapperState.initialValue:e.defaultValue!==""+t&&(e.defaultValue=""+t)}function sn(e,a,t,n){if(e=e.options,a){a={};for(var r=0;r<t.length;r++)a["$"+t[r]]=!0;for(t=0;t<e.length;t++)r=a.hasOwnProperty("$"+e[t].value),e[t].selected!==r&&(e[t].selected=r),r&&n&&(e[t].defaultSelected=!0)}else{t=""+lt(t),a=null;for(r=0;r<e.length;r++){if(e[r].value===t){e[r].selected=!0,n&&(e[r].defaultSelected=!0);return}a!==null||e[r].disabled||(a=e[r])}a!==null&&(a.selected=!0)}}function El(e,a){if(a.dangerouslySetInnerHTML!=null)throw Error(S(91));return le({},a,{value:void 0,defaultValue:void 0,children:""+e._wrapperState.initialValue})}function Zi(e,a){var t=a.value;if(t==null){if(t=a.children,a=a.defaultValue,t!=null){if(a!=null)throw Error(S(92));if(Gn(t)){if(1<t.length)throw Error(S(93));t=t[0]}a=t}a==null&&(a=""),t=a}e._wrapperState={initialValue:lt(t)}}function af(e,a){var t=lt(a.value),n=lt(a.defaultValue);t!=null&&(t=""+t,t!==e.value&&(e.value=t),a.defaultValue==null&&e.defaultValue!==t&&(e.defaultValue=t)),n!=null&&(e.defaultValue=""+n)}function Qi(e){var a=e.textContent;a===e._wrapperState.initialValue&&a!==""&&a!==null&&(e.value=a)}function tf(e){switch(e){case"svg":return"http://www.w3.org/2000/svg";case"math":return"http://www.w3.org/1998/Math/MathML";default:return"http://www.w3.org/1999/xhtml"}}function Nl(e,a){return e==null||e==="http://www.w3.org/1999/xhtml"?tf(a):e==="http://www.w3.org/2000/svg"&&a==="foreignObject"?"http://www.w3.org/1999/xhtml":e}function ir(e,a){if(a){var t=e.firstChild;if(t&&t===e.lastChild&&t.nodeType===3){t.nodeValue=a;return}}e.textContent=a}function rf(e,a,t){return a==null||typeof a==="boolean"||a===""?"":t||typeof a!=="number"||a===0||Jn.hasOwnProperty(e)&&Jn[e]?(""+a).trim():a+"px"}function of(e,a){e=e.style;for(var t in a)if(a.hasOwnProperty(t)){var n=t.indexOf("--")===0,r=rf(t,a[t],n);t==="float"&&(t="cssFloat"),n?e.setProperty(t,r):e[t]=r}}function Ol(e,a){if(a){if(jm[e]&&(a.children!=null||a.dangerouslySetInnerHTML!=null))throw Error(S(137,e));if(a.dangerouslySetInnerHTML!=null){if(a.children!=null)throw Error(S(60));if(typeof a.dangerouslySetInnerHTML!=="object"||!("__html"in a.dangerouslySetInnerHTML))throw Error(S(61))}if(a.style!=null&&typeof a.style!=="object")throw Error(S(62))}}function Ul(e,a){if(e.indexOf("-")===-1)return typeof a.is==="string";switch(e){case"annotation-xml":case"color-profile":case"font-face":case"font-face-src":case"font-face-uri":case"font-face-format":case"font-face-name":case"missing-glyph":return!1;default:return!0}}function _u(e){return e=e.target||e.srcElement||window,e.correspondingUseElement&&(e=e.correspondingUseElement),e.nodeType===3?e.parentNode:e}function Yi(e){if(e=ys(e)){if(typeof ql!=="function")throw Error(S(280));var a=e.stateNode;a&&(a=Uu(a),ql(e.stateNode,e.type,a))}}function $m(e){ln?un?un.push(e):un=[e]:ln=e}function Km(){if(ln){var e=ln,a=un;if(un=ln=null,Yi(e),a)for(e=0;e<a.length;e++)Yi(a[e])}}function sf(e,a){return e(a)}function lf(){}function uf(e,a,t){if(fl)return e(a,t);fl=!0;try{return sf(e,a,t)}finally{if(fl=!1,ln!==null||un!==null)lf(),Km()}}function dr(e,a){var t=e.stateNode;if(t===null)return null;var n=Uu(t);if(n===null)return null;t=n[a];e:switch(a){case"onClick":case"onClickCapture":case"onDoubleClick":case"onDoubleClickCapture":case"onMouseDown":case"onMouseDownCapture":case"onMouseMove":case"onMouseMoveCapture":case"onMouseUp":case"onMouseUpCapture":case"onMouseEnter":(n=!n.disabled)||(e=e.type,n=!(e==="button"||e==="input"||e==="select"||e==="textarea")),e=!n;break e;default:e=!1}if(e)return null;if(t&&typeof t!=="function")throw Error(S(231,a,typeof t));return t}function Xm(e,a,t,n,r,o,s,l,u){var c=Array.prototype.slice.call(arguments,3);try{a.apply(t,c)}catch(m){this.onError(m)}}function Qm(e,a,t,n,r,o,s,l,u){er=!1,Ko=null,Xm.apply(Zm,arguments)}function Ym(e,a,t,n,r,o,s,l,u){if(Qm.apply(this,arguments),er){if(er){var c=Ko;er=!1,Ko=null}else throw Error(S(198));Xo||(Xo=!0,Vl=c)}}function Ft(e){var a=e,t=e;if(e.alternate)for(;a.return;)a=a.return;else{e=a;do a=e,(a.flags&4098)!==0&&(t=a.return),e=a.return;while(e)}return a.tag===3?t:null}function df(e){if(e.tag===13){var a=e.memoizedState;if(a===null&&(e=e.alternate,e!==null&&(a=e.memoizedState)),a!==null)return a.dehydrated}return null}function Ji(e){if(Ft(e)!==e)throw Error(S(188))}function Jm(e){var a=e.alternate;if(!a){if(a=Ft(e),a===null)throw Error(S(188));return a!==e?null:e}for(var t=e,n=a;;){var r=t.return;if(r===null)break;var o=r.alternate;if(o===null){if(n=r.return,n!==null){t=n;continue}break}if(r.child===o.child){for(o=r.child;o;){if(o===t)return Ji(r),e;if(o===n)return Ji(r),a;o=o.sibling}throw Error(S(188))}if(t.return!==n.return)t=r,n=o;else{for(var s=!1,l=r.child;l;){if(l===t){s=!0,t=r,n=o;break}if(l===n){s=!0,n=r,t=o;break}l=l.sibling}if(!s){for(l=o.child;l;){if(l===t){s=!0,t=o,n=r;break}if(l===n){s=!0,n=o,t=r;break}l=l.sibling}if(!s)throw Error(S(189))}}if(t.alternate!==n)throw Error(S(190))}if(t.tag!==3)throw Error(S(188));return t.stateNode.current===t?e:a}function eh(e){return e=Jm(e),e!==null?ff(e):null}function ff(e){if(e.tag===5||e.tag===6)return e;for(e=e.child;e!==null;){var a=ff(e);if(a!==null)return a;e=e.sibling}return null}function oh(e){if(_a&&typeof _a.onCommitFiberRoot==="function")try{_a.onCommitFiberRoot(gs,e,void 0,(e.current.flags&128)===128)}catch(a){}}function uh(e){return e>>>=0,e===0?32:31-(sh(e)/lh|0)|0}function jn(e){switch(e&-e){case 1:return 1;case 2:return 2;case 4:return 4;case 8:return 8;case 16:return 16;case 32:return 32;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return e&4194240;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return e&130023424;case 134217728:return 134217728;case 268435456:return 268435456;case 536870912:return 536870912;case 1073741824:return 1073741824;default:return e}}function Qo(e,a){var t=e.pendingLanes;if(t===0)return 0;var n=0,r=e.suspendedLanes,o=e.pingedLanes,s=t&268435455;if(s!==0){var l=s&~r;l!==0?n=jn(l):(o&=s,o!==0&&(n=jn(o)))}else s=t&~r,s!==0?n=jn(s):o!==0&&(n=jn(o));if(n===0)return 0;if(a!==0&&a!==n&&(a&r)===0&&(r=n&-n,o=a&-a,r>=o||r===16&&(o&4194240)!==0))return a;if((n&4)!==0&&(n|=t&16),a=e.entangledLanes,a!==0)for(e=e.entanglements,a&=n;0<a;)t=31-ha(a),r=1<<t,n|=e[t],a&=~r;return n}function ih(e,a){switch(e){case 1:case 2:case 4:return a+250;case 8:case 16:case 32:case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return a+5000;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return-1;case 134217728:case 268435456:case 536870912:case 1073741824:return-1;default:return-1}}function dh(e,a){for(var{suspendedLanes:t,pingedLanes:n,expirationTimes:r,pendingLanes:o}=e;0<o;){var s=31-ha(o),l=1<<s,u=r[s];if(u===-1){if((l&t)===0||(l&n)!==0)r[s]=ih(l,a)}else u<=a&&(e.expiredLanes|=l);o&=~l}}function Gl(e){return e=e.pendingLanes&-1073741825,e!==0?e:e&1073741824?1073741824:0}function hf(){var e=Co;return Co<<=1,(Co&4194240)===0&&(Co=64),e}function cl(e){for(var a=[],t=0;31>t;t++)a.push(e);return a}function Cr(e,a,t){e.pendingLanes|=a,a!==536870912&&(e.suspendedLanes=0,e.pingedLanes=0),e=e.eventTimes,a=31-ha(a),e[a]=t}function fh(e,a){var t=e.pendingLanes&~a;e.pendingLanes=a,e.suspendedLanes=0,e.pingedLanes=0,e.expiredLanes&=a,e.mutableReadLanes&=a,e.entangledLanes&=a,a=e.entanglements;var n=e.eventTimes;for(e=e.expirationTimes;0<t;){var r=31-ha(t),o=1<<r;a[r]=0,n[r]=-1,e[r]=-1,t&=~o}}function zu(e,a){var t=e.entangledLanes|=a;for(e=e.entanglements;t;){var n=31-ha(t),r=1<<n;r&a|e[n]&a&&(e[n]|=a),t&=~r}}function gf(e){return e&=-e,1<e?4<e?(e&268435455)!==0?16:536870912:4:1}function ad(e,a){switch(e){case"focusin":case"focusout":Ja=null;break;case"dragenter":case"dragleave":et=null;break;case"mouseover":case"mouseout":at=null;break;case"pointerover":case"pointerout":fr.delete(a.pointerId);break;case"gotpointercapture":case"lostpointercapture":cr.delete(a.pointerId)}}function En(e,a,t,n,r,o){if(e===null||e.nativeEvent!==o)return e={blockedOn:a,domEventName:t,eventSystemFlags:n,nativeEvent:o,targetContainers:[r]},a!==null&&(a=ys(a),a!==null&&Tu(a)),e;return e.eventSystemFlags|=n,a=e.targetContainers,r!==null&&a.indexOf(r)===-1&&a.push(r),e}function ph(e,a,t,n,r){switch(a){case"focusin":return Ja=En(Ja,e,a,t,n,r),!0;case"dragenter":return et=En(et,e,a,t,n,r),!0;case"mouseover":return at=En(at,e,a,t,n,r),!0;case"pointerover":var o=r.pointerId;return fr.set(o,En(fr.get(o)||null,e,a,t,n,r)),!0;case"gotpointercapture":return o=r.pointerId,cr.set(o,En(cr.get(o)||null,e,a,t,n,r)),!0}return!1}function vf(e){var a=Ct(e.target);if(a!==null){var t=Ft(a);if(t!==null){if(a=t.tag,a===13){if(a=df(t),a!==null){e.blockedOn=a,yf(e.priority,function(){wf(t)});return}}else if(a===3&&t.stateNode.current.memoizedState.isDehydrated){e.blockedOn=t.tag===3?t.stateNode.containerInfo:null;return}}}e.blockedOn=null}function Bo(e){if(e.blockedOn!==null)return!1;for(var a=e.targetContainers;0<a.length;){var t=$l(e.domEventName,e.eventSystemFlags,a[0],e.nativeEvent);if(t===null){t=e.nativeEvent;var n=new t.constructor(t.type,t);Hl=n,t.target.dispatchEvent(n),Hl=null}else return a=ys(t),a!==null&&Tu(a),e.blockedOn=t,!1;a.shift()}return!0}function td(e,a,t){Bo(e)&&t.delete(a)}function mh(){jl=!1,Ja!==null&&Bo(Ja)&&(Ja=null),et!==null&&Bo(et)&&(et=null),at!==null&&Bo(at)&&(at=null),fr.forEach(td),cr.forEach(td)}function Nn(e,a){e.blockedOn===a&&(e.blockedOn=null,jl||(jl=!0,re.unstable_scheduleCallback(re.unstable_NormalPriority,mh)))}function pr(e){function a(r){return Nn(r,e)}if(0<bo.length){Nn(bo[0],e);for(var t=1;t<bo.length;t++){var n=bo[t];n.blockedOn===e&&(n.blockedOn=null)}}Ja!==null&&Nn(Ja,e),et!==null&&Nn(et,e),at!==null&&Nn(at,e),fr.forEach(a),cr.forEach(a);for(t=0;t<Xa.length;t++)n=Xa[t],n.blockedOn===e&&(n.blockedOn=null);for(;0<Xa.length&&(t=Xa[0],t.blockedOn===null);)vf(t),t.blockedOn===null&&Xa.shift()}function hh(e,a,t,n){var r=K,o=dn.transition;dn.transition=null;try{K=1,Ru(e,a,t,n)}finally{K=r,dn.transition=o}}function gh(e,a,t,n){var r=K,o=dn.transition;dn.transition=null;try{K=4,Ru(e,a,t,n)}finally{K=r,dn.transition=o}}function Ru(e,a,t,n){if(Yo){var r=$l(e,a,t,n);if(r===null)wl(e,a,n,Jo,t),ad(e,n);else if(ph(r,e,a,t,n))n.stopPropagation();else if(ad(e,n),a&4&&-1<ch.indexOf(e)){for(;r!==null;){var o=ys(r);if(o!==null&&xf(o),o=$l(e,a,t,n),o===null&&wl(e,a,n,Jo,t),o===r)break;r=o}r!==null&&n.stopPropagation()}else wl(e,a,n,null,t)}}function $l(e,a,t,n){if(Jo=null,e=_u(n),e=Ct(e),e!==null)if(a=Ft(e),a===null)e=null;else if(t=a.tag,t===13){if(e=df(a),e!==null)return e;e=null}else if(t===3){if(a.stateNode.current.memoizedState.isDehydrated)return a.tag===3?a.stateNode.containerInfo:null;e=null}else a!==e&&(e=null);return Jo=e,null}function If(e){switch(e){case"cancel":case"click":case"close":case"contextmenu":case"copy":case"cut":case"auxclick":case"dblclick":case"dragend":case"dragstart":case"drop":case"focusin":case"focusout":case"input":case"invalid":case"keydown":case"keypress":case"keyup":case"mousedown":case"mouseup":case"paste":case"pause":case"play":case"pointercancel":case"pointerdown":case"pointerup":case"ratechange":case"reset":case"resize":case"seeked":case"submit":case"touchcancel":case"touchend":case"touchstart":case"volumechange":case"change":case"selectionchange":case"textInput":case"compositionstart":case"compositionend":case"compositionupdate":case"beforeblur":case"afterblur":case"beforeinput":case"blur":case"fullscreenchange":case"focus":case"hashchange":case"popstate":case"select":case"selectstart":return 1;case"drag":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"mousemove":case"mouseout":case"mouseover":case"pointermove":case"pointerout":case"pointerover":case"scroll":case"toggle":case"touchmove":case"wheel":case"mouseenter":case"mouseleave":case"pointerenter":case"pointerleave":return 4;case"message":switch(nh()){case Au:return 1;case pf:return 4;case Zo:case rh:return 16;case mf:return 536870912;default:return 16}default:return 16}}function kf(){if(Eo)return Eo;var e,a=Fu,t=a.length,n,r="value"in Qa?Qa.value:Qa.textContent,o=r.length;for(e=0;e<t&&a[e]===r[e];e++);var s=t-e;for(n=1;n<=s&&a[t-n]===r[o-n];n++);return Eo=r.slice(e,1<n?1-n:void 0)}function No(e){var a=e.keyCode;return"charCode"in e?(e=e.charCode,e===0&&a===13&&(e=13)):e=a,e===10&&(e=13),32<=e||e===13?e:0}function Po(){return!0}function nd(){return!1}function Xe(e){function a(t,n,r,o,s){this._reactName=t,this._targetInst=r,this.type=n,this.nativeEvent=o,this.target=s,this.currentTarget=null;for(var l in e)e.hasOwnProperty(l)&&(t=e[l],this[l]=t?t(o):o[l]);return this.isDefaultPrevented=(o.defaultPrevented!=null?o.defaultPrevented:o.returnValue===!1)?Po:nd,this.isPropagationStopped=nd,this}return le(a.prototype,{preventDefault:function(){this.defaultPrevented=!0;var t=this.nativeEvent;t&&(t.preventDefault?t.preventDefault():typeof t.returnValue!=="unknown"&&(t.returnValue=!1),this.isDefaultPrevented=Po)},stopPropagation:function(){var t=this.nativeEvent;t&&(t.stopPropagation?t.stopPropagation():typeof t.cancelBubble!=="unknown"&&(t.cancelBubble=!0),this.isPropagationStopped=Po)},persist:function(){},isPersistent:Po}),a}function _h(e){var a=this.nativeEvent;return a.getModifierState?a.getModifierState(e):(e=Mh[e])?!!a[e]:!1}function Bu(){return _h}function Sf(e,a){switch(e){case"keyup":return Oh.indexOf(a.keyCode)!==-1;case"keydown":return a.keyCode!==229;case"keypress":case"mousedown":case"focusout":return!0;default:return!1}}function bf(e){return e=e.detail,typeof e==="object"&&"data"in e?e.data:null}function Hh(e,a){switch(e){case"compositionend":return bf(a);case"keypress":if(a.which!==32)return null;return ud=!0,ld;case"textInput":return e=a.data,e===ld&&ud?null:e;default:return null}}function qh(e,a){if(Qt)return e==="compositionend"||!Eu&&Sf(e,a)?(e=kf(),Eo=Fu=Qa=null,Qt=!1,e):null;switch(e){case"paste":return null;case"keypress":if(!(a.ctrlKey||a.altKey||a.metaKey)||a.ctrlKey&&a.altKey){if(a.char&&1<a.char.length)return a.char;if(a.which)return String.fromCharCode(a.which)}return null;case"compositionend":return Cf&&a.locale!=="ko"?null:a.data;default:return null}}function id(e){var a=e&&e.nodeName&&e.nodeName.toLowerCase();return a==="input"?!!Wh[e.type]:a==="textarea"?!0:!1}function Pf(e,a,t,n){$m(n),a=es(a,"onChange"),0<a.length&&(t=new Du("onChange","change",null,t,n),e.push({event:t,listeners:a}))}function Vh(e){Nf(e,0)}function ws(e){var a=Yn(e);if(Jd(a))return e}function Gh(e,a){if(e==="change")return a}function dd(){tr&&(tr.detachEvent("onpropertychange",_f),mr=tr=null)}function _f(e){if(e.propertyName==="value"&&ws(mr)){var a=[];Pf(a,mr,e,_u(e)),uf(Vh,a)}}function jh(e,a,t){e==="focusin"?(dd(),tr=a,mr=t,tr.attachEvent("onpropertychange",_f)):e==="focusout"&&dd()}function $h(e){if(e==="selectionchange"||e==="keyup"||e==="keydown")return ws(mr)}function Kh(e,a){if(e==="click")return ws(a)}function Xh(e,a){if(e==="input"||e==="change")return ws(a)}function Zh(e,a){return e===a&&(e!==0||1/e===1/a)||e!==e&&a!==a}function hr(e,a){if(xa(e,a))return!0;if(typeof e!=="object"||e===null||typeof a!=="object"||a===null)return!1;var t=Object.keys(e),n=Object.keys(a);if(t.length!==n.length)return!1;for(n=0;n<t.length;n++){var r=t[n];if(!_l.call(a,r)||!xa(e[r],a[r]))return!1}return!0}function fd(e){for(;e&&e.firstChild;)e=e.firstChild;return e}function cd(e,a){var t=fd(e);e=0;for(var n;t;){if(t.nodeType===3){if(n=e+t.textContent.length,e<=a&&n>=a)return{node:t,offset:a-e};e=n}e:{for(;t;){if(t.nextSibling){t=t.nextSibling;break e}t=t.parentNode}t=void 0}t=fd(t)}}function Af(e,a){return e&&a?e===a?!0:e&&e.nodeType===3?!1:a&&a.nodeType===3?Af(e,a.parentNode):("contains"in e)?e.contains(a):e.compareDocumentPosition?!!(e.compareDocumentPosition(a)&16):!1:!1}function zf(){for(var e=window,a=$o();a instanceof e.HTMLIFrameElement;){try{var t=typeof a.contentWindow.location.href==="string"}catch(n){t=!1}if(t)e=a.contentWindow;else break;a=$o(e.document)}return a}function Nu(e){var a=e&&e.nodeName&&e.nodeName.toLowerCase();return a&&(a==="input"&&(e.type==="text"||e.type==="search"||e.type==="tel"||e.type==="url"||e.type==="password")||a==="textarea"||e.contentEditable==="true")}function Qh(e){var a=zf(),t=e.focusedElem,n=e.selectionRange;if(a!==t&&t&&t.ownerDocument&&Af(t.ownerDocument.documentElement,t)){if(n!==null&&Nu(t)){if(a=n.start,e=n.end,e===void 0&&(e=a),"selectionStart"in t)t.selectionStart=a,t.selectionEnd=Math.min(e,t.value.length);else if(e=(a=t.ownerDocument||document)&&a.defaultView||window,e.getSelection){e=e.getSelection();var r=t.textContent.length,o=Math.min(n.start,r);n=n.end===void 0?o:Math.min(n.end,r),!e.extend&&o>n&&(r=n,n=o,o=r),r=cd(t,o);var s=cd(t,n);r&&s&&(e.rangeCount!==1||e.anchorNode!==r.node||e.anchorOffset!==r.offset||e.focusNode!==s.node||e.focusOffset!==s.offset)&&(a=a.createRange(),a.setStart(r.node,r.offset),e.removeAllRanges(),o>n?(e.addRange(a),e.extend(s.node,s.offset)):(a.setEnd(s.node,s.offset),e.addRange(a)))}}a=[];for(e=t;e=e.parentNode;)e.nodeType===1&&a.push({element:e,left:e.scrollLeft,top:e.scrollTop});typeof t.focus==="function"&&t.focus();for(t=0;t<a.length;t++)e=a[t],e.element.scrollLeft=e.left,e.element.scrollTop=e.top}}function pd(e,a,t){var n=t.window===t?t.document:t.nodeType===9?t:t.ownerDocument;Xl||Yt==null||Yt!==$o(n)||(n=Yt,("selectionStart"in n)&&Nu(n)?n={start:n.selectionStart,end:n.selectionEnd}:(n=(n.ownerDocument&&n.ownerDocument.defaultView||window).getSelection(),n={anchorNode:n.anchorNode,anchorOffset:n.anchorOffset,focusNode:n.focusNode,focusOffset:n.focusOffset}),nr&&hr(nr,n)||(nr=n,n=es(Kl,"onSelect"),0<n.length&&(a=new Du("onSelect","select",null,a,t),e.push({event:a,listeners:n}),a.target=Yt)))}function Mo(e,a){var t={};return t[e.toLowerCase()]=a.toLowerCase(),t["Webkit"+e]="webkit"+a,t["Moz"+e]="moz"+a,t}function Ls(e){if(gl[e])return gl[e];if(!Jt[e])return e;var a=Jt[e],t;for(t in a)if(a.hasOwnProperty(t)&&t in Tf)return gl[e]=a[t];return e}function it(e,a){Ef.set(e,a),Rt(a,[e])}function hd(e,a,t){var n=e.type||"unknown-event";e.currentTarget=t,Ym(n,a,void 0,e),e.currentTarget=null}function Nf(e,a){a=(a&4)!==0;for(var t=0;t<e.length;t++){var n=e[t],r=n.event;n=n.listeners;e:{var o=void 0;if(a)for(var s=n.length-1;0<=s;s--){var l=n[s],u=l.instance,c=l.currentTarget;if(l=l.listener,u!==o&&r.isPropagationStopped())break e;hd(r,l,c),o=u}else for(s=0;s<n.length;s++){if(l=n[s],u=l.instance,c=l.currentTarget,l=l.listener,u!==o&&r.isPropagationStopped())break e;hd(r,l,c),o=u}}}if(Xo)throw e=Vl,Xo=!1,Vl=null,e}function ae(e,a){var t=a[tu];t===void 0&&(t=a[tu]=new Set);var n=e+"__bubble";t.has(n)||(Of(a,e,2,!1),t.add(n))}function xl(e,a,t){var n=0;a&&(n|=4),Of(t,e,n,a)}function Ou(e){if(!e[_o]){e[_o]=!0,Kd.forEach(function(t){t!=="selectionchange"&&(Jh.has(t)||xl(t,!1,e),xl(t,!0,e))});var a=e.nodeType===9?e:e.ownerDocument;a===null||a[_o]||(a[_o]=!0,xl("selectionchange",!1,a))}}function Of(e,a,t,n){switch(If(a)){case 1:var r=hh;break;case 4:r=gh;break;default:r=Ru}t=r.bind(null,a,t,e),r=void 0,!Wl||a!=="touchstart"&&a!=="touchmove"&&a!=="wheel"||(r=!0),n?r!==void 0?e.addEventListener(a,t,{capture:!0,passive:r}):e.addEventListener(a,t,!0):r!==void 0?e.addEventListener(a,t,{passive:r}):e.addEventListener(a,t,!1)}function wl(e,a,t,n,r){var o=n;if((a&1)===0&&(a&2)===0&&n!==null)e:for(;;){if(n===null)return;var s=n.tag;if(s===3||s===4){var l=n.stateNode.containerInfo;if(l===r||l.nodeType===8&&l.parentNode===r)break;if(s===4)for(s=n.return;s!==null;){var u=s.tag;if(u===3||u===4){if(u=s.stateNode.containerInfo,u===r||u.nodeType===8&&u.parentNode===r)return}s=s.return}for(;l!==null;){if(s=Ct(l),s===null)return;if(u=s.tag,u===5||u===6){n=o=s;continue e}l=l.parentNode}}n=n.return}uf(function(){var c=o,m=_u(t),g=[];e:{var h=Ef.get(e);if(h!==void 0){var w=Du,x=e;switch(e){case"keypress":if(No(t)===0)break e;case"keydown":case"keyup":w=zh;break;case"focusin":x="focus",w=hl;break;case"focusout":x="blur",w=hl;break;case"beforeblur":case"afterblur":w=hl;break;case"click":if(t.button===2)break e;case"auxclick":case"dblclick":case"mousedown":case"mousemove":case"mouseup":case"mouseout":case"mouseover":case"contextmenu":w=rd;break;case"drag":case"dragend":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"dragstart":case"drop":w=Lh;break;case"touchcancel":case"touchend":case"touchmove":case"touchstart":w=Fh;break;case Rf:case Ff:case Df:w=Ih;break;case Bf:w=Bh;break;case"scroll":w=xh;break;case"wheel":w=Nh;break;case"copy":case"cut":case"paste":w=Ch;break;case"gotpointercapture":case"lostpointercapture":case"pointercancel":case"pointerdown":case"pointermove":case"pointerout":case"pointerover":case"pointerup":w=sd}var k=(a&4)!==0,B=!k&&e==="scroll",f=k?h!==null?h+"Capture":null:h;k=[];for(var d=c,p;d!==null;){p=d;var L=p.stateNode;if(p.tag===5&&L!==null&&(p=L,f!==null&&(L=dr(d,f),L!=null&&k.push(gr(d,L,p)))),B)break;d=d.return}0<k.length&&(h=new w(h,x,null,t,m),g.push({event:h,listeners:k}))}}if((a&7)===0){e:{if(h=e==="mouseover"||e==="pointerover",w=e==="mouseout"||e==="pointerout",h&&t!==Hl&&(x=t.relatedTarget||t.fromElement)&&(Ct(x)||x[In]))break e;if(w||h){if(h=m.window===m?m:(h=m.ownerDocument)?h.defaultView||h.parentWindow:window,w){if(x=t.relatedTarget||t.toElement,w=c,x=x?Ct(x):null,x!==null&&(B=Ft(x),x!==B||x.tag!==5&&x.tag!==6))x=null}else w=null,x=c;if(w!==x){if(k=rd,L="onMouseLeave",f="onMouseEnter",d="mouse",e==="pointerout"||e==="pointerover")k=sd,L="onPointerLeave",f="onPointerEnter",d="pointer";if(B=w==null?h:Yn(w),p=x==null?h:Yn(x),h=new k(L,d+"leave",w,t,m),h.target=B,h.relatedTarget=p,L=null,Ct(m)===c&&(k=new k(f,d+"enter",x,t,m),k.target=p,k.relatedTarget=B,L=k),B=L,w&&x)a:{k=w,f=x,d=0;for(p=k;p;p=Kt(p))d++;p=0;for(L=f;L;L=Kt(L))p++;for(;0<d-p;)k=Kt(k),d--;for(;0<p-d;)f=Kt(f),p--;for(;d--;){if(k===f||f!==null&&k===f.alternate)break a;k=Kt(k),f=Kt(f)}k=null}else k=null;w!==null&&gd(g,h,w,k,!1),x!==null&&B!==null&&gd(g,B,x,k,!0)}}}e:{if(h=c?Yn(c):window,w=h.nodeName&&h.nodeName.toLowerCase(),w==="select"||w==="input"&&h.type==="file")var I=Gh;else if(id(h))if(Mf)I=Xh;else{I=$h;var T=jh}else(w=h.nodeName)&&w.toLowerCase()==="input"&&(h.type==="checkbox"||h.type==="radio")&&(I=Kh);if(I&&(I=I(e,c))){Pf(g,I,t,m);break e}T&&T(e,h,c),e==="focusout"&&(T=h._wrapperState)&&T.controlled&&h.type==="number"&&Bl(h,"number",h.value)}switch(T=c?Yn(c):window,e){case"focusin":if(id(T)||T.contentEditable==="true")Yt=T,Kl=c,nr=null;break;case"focusout":nr=Kl=Yt=null;break;case"mousedown":Xl=!0;break;case"contextmenu":case"mouseup":case"dragend":Xl=!1,pd(g,t,m);break;case"selectionchange":if(Yh)break;case"keydown":case"keyup":pd(g,t,m)}var F;if(Eu)e:{switch(e){case"compositionstart":var y="onCompositionStart";break e;case"compositionend":y="onCompositionEnd";break e;case"compositionupdate":y="onCompositionUpdate";break e}y=void 0}else Qt?Sf(e,t)&&(y="onCompositionEnd"):e==="keydown"&&t.keyCode===229&&(y="onCompositionStart");if(y&&(Cf&&t.locale!=="ko"&&(Qt||y!=="onCompositionStart"?y==="onCompositionEnd"&&Qt&&(F=kf()):(Qa=m,Fu=("value"in Qa)?Qa.value:Qa.textContent,Qt=!0)),T=es(c,y),0<T.length&&(y=new od(y,e,null,t,m),g.push({event:y,listeners:T}),F?y.data=F:(F=bf(t),F!==null&&(y.data=F)))),F=Uh?Hh(e,t):qh(e,t))c=es(c,"onBeforeInput"),0<c.length&&(m=new od("onBeforeInput","beforeinput",null,t,m),g.push({event:m,listeners:c}),m.data=F)}Nf(g,a)})}function gr(e,a,t){return{instance:e,listener:a,currentTarget:t}}function es(e,a){for(var t=a+"Capture",n=[];e!==null;){var r=e,o=r.stateNode;r.tag===5&&o!==null&&(r=o,o=dr(e,t),o!=null&&n.unshift(gr(e,o,r)),o=dr(e,a),o!=null&&n.push(gr(e,o,r))),e=e.return}return n}function Kt(e){if(e===null)return null;do e=e.return;while(e&&e.tag!==5);return e?e:null}function gd(e,a,t,n,r){for(var o=a._reactName,s=[];t!==null&&t!==n;){var l=t,u=l.alternate,c=l.stateNode;if(u!==null&&u===n)break;l.tag===5&&c!==null&&(l=c,r?(u=dr(t,o),u!=null&&s.unshift(gr(t,u,l))):r||(u=dr(t,o),u!=null&&s.push(gr(t,u,l)))),t=t.return}s.length!==0&&e.push({event:a,listeners:s})}function xd(e){return(typeof e==="string"?e:""+e).replace(e0,`
`).replace(a0,"")}function Ao(e,a,t){if(a=xd(a),xd(e)!==a&&t)throw Error(S(425))}function as(){}function eu(e,a){return e==="textarea"||e==="noscript"||typeof a.children==="string"||typeof a.children==="number"||typeof a.dangerouslySetInnerHTML==="object"&&a.dangerouslySetInnerHTML!==null&&a.dangerouslySetInnerHTML.__html!=null}function r0(e){setTimeout(function(){throw e})}function Ll(e,a){var t=a,n=0;do{var r=t.nextSibling;if(e.removeChild(t),r&&r.nodeType===8)if(t=r.data,t==="/$"){if(n===0){e.removeChild(r),pr(a);return}n--}else t!=="$"&&t!=="$?"&&t!=="$!"||n++;t=r}while(t);pr(a)}function tt(e){for(;e!=null;e=e.nextSibling){var a=e.nodeType;if(a===1||a===3)break;if(a===8){if(a=e.data,a==="$"||a==="$!"||a==="$?")break;if(a==="/$")return null}}return e}function Ld(e){e=e.previousSibling;for(var a=0;e;){if(e.nodeType===8){var t=e.data;if(t==="$"||t==="$!"||t==="$?"){if(a===0)return e;a--}else t==="/$"&&a++}e=e.previousSibling}return null}function Ct(e){var a=e[Ma];if(a)return a;for(var t=e.parentNode;t;){if(a=t[In]||t[Ma]){if(t=a.alternate,a.child!==null||t!==null&&t.child!==null)for(e=Ld(e);e!==null;){if(t=e[Ma])return t;e=Ld(e)}return a}e=t,t=e.parentNode}return null}function ys(e){return e=e[Ma]||e[In],!e||e.tag!==5&&e.tag!==6&&e.tag!==13&&e.tag!==3?null:e}function Yn(e){if(e.tag===5||e.tag===6)return e.stateNode;throw Error(S(33))}function Uu(e){return e[xr]||null}function dt(e){return{current:e}}function te(e){0>en||(e.current=nu[en],nu[en]=null,en--)}function Y(e,a){en++,nu[en]=e.current,e.current=a}function mn(e,a){var t=e.type.contextTypes;if(!t)return ut;var n=e.stateNode;if(n&&n.__reactInternalMemoizedUnmaskedChildContext===a)return n.__reactInternalMemoizedMaskedChildContext;var r={},o;for(o in t)r[o]=a[o];return n&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=a,e.__reactInternalMemoizedMaskedChildContext=r),r}function qe(e){return e=e.childContextTypes,e!==null&&e!==void 0}function ts(){te(He),te(Re)}function yd(e,a,t){if(Re.current!==ut)throw Error(S(168));Y(Re,a),Y(He,t)}function Uf(e,a,t){var n=e.stateNode;if(a=a.childContextTypes,typeof n.getChildContext!=="function")return t;n=n.getChildContext();for(var r in n)if(!(r in a))throw Error(S(108,Wm(e)||"Unknown",r));return le({},t,n)}function ns(e){return e=(e=e.stateNode)&&e.__reactInternalMemoizedMergedChildContext||ut,_t=Re.current,Y(Re,e),Y(He,He.current),!0}function vd(e,a,t){var n=e.stateNode;if(!n)throw Error(S(169));t?(e=Uf(e,a,_t),n.__reactInternalMemoizedMergedChildContext=e,te(He),te(Re),Y(Re,e)):te(He),Y(He,t)}function Hf(e){Ea===null?Ea=[e]:Ea.push(e)}function l0(e){vs=!0,Hf(e)}function ft(){if(!yl&&Ea!==null){yl=!0;var e=0,a=K;try{var t=Ea;for(K=1;e<t.length;e++){var n=t[e];do n=n(!0);while(n!==null)}Ea=null,vs=!1}catch(r){throw Ea!==null&&(Ea=Ea.slice(e+1)),cf(Au,ft),r}finally{K=a,yl=!1}}return null}function It(e,a){an[tn++]=os,an[tn++]=rs,rs=e,os=a}function qf(e,a,t){Je[ea++]=Na,Je[ea++]=Oa,Je[ea++]=At,At=e;var n=Na;e=Oa;var r=32-ha(n)-1;n&=~(1<<r),t+=1;var o=32-ha(a)+r;if(30<o){var s=r-r%5;o=(n&(1<<s)-1).toString(32),n>>=s,r-=s,Na=1<<32-ha(a)+r|t<<r|n,Oa=o+e}else Na=1<<o|t<<r|n,Oa=e}function Hu(e){e.return!==null&&(It(e,1),qf(e,1,0))}function qu(e){for(;e===rs;)rs=an[--tn],an[tn]=null,os=an[--tn],an[tn]=null;for(;e===At;)At=Je[--ea],Je[ea]=null,Oa=Je[--ea],Je[ea]=null,Na=Je[--ea],Je[ea]=null}function Wf(e,a){var t=aa(5,null,null,0);t.elementType="DELETED",t.stateNode=a,t.return=e,a=e.deletions,a===null?(e.deletions=[t],e.flags|=16):a.push(t)}function Id(e,a){switch(e.tag){case 5:var t=e.type;return a=a.nodeType!==1||t.toLowerCase()!==a.nodeName.toLowerCase()?null:a,a!==null?(e.stateNode=a,Ke=e,$e=tt(a.firstChild),!0):!1;case 6:return a=e.pendingProps===""||a.nodeType!==3?null:a,a!==null?(e.stateNode=a,Ke=e,$e=null,!0):!1;case 13:return a=a.nodeType!==8?null:a,a!==null?(t=At!==null?{id:Na,overflow:Oa}:null,e.memoizedState={dehydrated:a,treeContext:t,retryLane:1073741824},t=aa(18,null,null,0),t.stateNode=a,t.return=e,e.child=t,Ke=e,$e=null,!0):!1;default:return!1}}function ru(e){return(e.mode&1)!==0&&(e.flags&128)===0}function ou(e){if(ne){var a=$e;if(a){var t=a;if(!Id(e,a)){if(ru(e))throw Error(S(418));a=tt(t.nextSibling);var n=Ke;a&&Id(e,a)?Wf(n,t):(e.flags=e.flags&-4097|2,ne=!1,Ke=e)}}else{if(ru(e))throw Error(S(418));e.flags=e.flags&-4097|2,ne=!1,Ke=e}}}function kd(e){for(e=e.return;e!==null&&e.tag!==5&&e.tag!==3&&e.tag!==13;)e=e.return;Ke=e}function zo(e){if(e!==Ke)return!1;if(!ne)return kd(e),ne=!0,!1;var a;if((a=e.tag!==3)&&!(a=e.tag!==5)&&(a=e.type,a=a!=="head"&&a!=="body"&&!eu(e.type,e.memoizedProps)),a&&(a=$e)){if(ru(e))throw Vf(),Error(S(418));for(;a;)Wf(e,a),a=tt(a.nextSibling)}if(kd(e),e.tag===13){if(e=e.memoizedState,e=e!==null?e.dehydrated:null,!e)throw Error(S(317));e:{e=e.nextSibling;for(a=0;e;){if(e.nodeType===8){var t=e.data;if(t==="/$"){if(a===0){$e=tt(e.nextSibling);break e}a--}else t!=="$"&&t!=="$!"&&t!=="$?"||a++}e=e.nextSibling}$e=null}}else $e=Ke?tt(e.stateNode.nextSibling):null;return!0}function Vf(){for(var e=$e;e;)e=tt(e.nextSibling)}function hn(){$e=Ke=null,ne=!1}function Wu(e){ma===null?ma=[e]:ma.push(e)}function Un(e,a,t){if(e=t.ref,e!==null&&typeof e!=="function"&&typeof e!=="object"){if(t._owner){if(t=t._owner,t){if(t.tag!==1)throw Error(S(309));var n=t.stateNode}if(!n)throw Error(S(147,e));var r=n,o=""+e;if(a!==null&&a.ref!==null&&typeof a.ref==="function"&&a.ref._stringRef===o)return a.ref;return a=function(s){var l=r.refs;s===null?delete l[o]:l[o]=s},a._stringRef=o,a}if(typeof e!=="string")throw Error(S(284));if(!t._owner)throw Error(S(290,e))}return e}function To(e,a){throw e=Object.prototype.toString.call(a),Error(S(31,e==="[object Object]"?"object with keys {"+Object.keys(a).join(", ")+"}":e))}function Cd(e){var a=e._init;return a(e._payload)}function Gf(e){function a(f,d){if(e){var p=f.deletions;p===null?(f.deletions=[d],f.flags|=16):p.push(d)}}function t(f,d){if(!e)return null;for(;d!==null;)a(f,d),d=d.sibling;return null}function n(f,d){for(f=new Map;d!==null;)d.key!==null?f.set(d.key,d):f.set(d.index,d),d=d.sibling;return f}function r(f,d){return f=st(f,d),f.index=0,f.sibling=null,f}function o(f,d,p){if(f.index=p,!e)return f.flags|=1048576,d;if(p=f.alternate,p!==null)return p=p.index,p<d?(f.flags|=2,d):p;return f.flags|=2,d}function s(f){return e&&f.alternate===null&&(f.flags|=2),f}function l(f,d,p,L){if(d===null||d.tag!==6)return d=Pl(p,f.mode,L),d.return=f,d;return d=r(d,p),d.return=f,d}function u(f,d,p,L){var I=p.type;if(I===Zt)return m(f,d,p.props.children,L,p.key);if(d!==null&&(d.elementType===I||typeof I==="object"&&I!==null&&I.$$typeof===$a&&Cd(I)===d.type))return L=r(d,p.props),L.ref=Un(f,d,p),L.return=f,L;return L=jo(p.type,p.key,p.props,null,f.mode,L),L.ref=Un(f,d,p),L.return=f,L}function c(f,d,p,L){if(d===null||d.tag!==4||d.stateNode.containerInfo!==p.containerInfo||d.stateNode.implementation!==p.implementation)return d=Ml(p,f.mode,L),d.return=f,d;return d=r(d,p.children||[]),d.return=f,d}function m(f,d,p,L,I){if(d===null||d.tag!==7)return d=Mt(p,f.mode,L,I),d.return=f,d;return d=r(d,p),d.return=f,d}function g(f,d,p){if(typeof d==="string"&&d!==""||typeof d==="number")return d=Pl(""+d,f.mode,p),d.return=f,d;if(typeof d==="object"&&d!==null){switch(d.$$typeof){case vo:return p=jo(d.type,d.key,d.props,null,f.mode,p),p.ref=Un(f,null,d),p.return=f,p;case Wn:return d=Ml(d,f.mode,p),d.return=f,d;case $a:var L=d._init;return g(f,L(d._payload),p)}if(Gn(d)||Bn(d))return d=Mt(d,f.mode,p,null),d.return=f,d;To(f,d)}return null}function h(f,d,p,L){var I=d!==null?d.key:null;if(typeof p==="string"&&p!==""||typeof p==="number")return I!==null?null:l(f,d,""+p,L);if(typeof p==="object"&&p!==null){switch(p.$$typeof){case vo:return p.key===I?u(f,d,p,L):null;case Wn:return p.key===I?c(f,d,p,L):null;case $a:return I=p._init,h(f,d,I(p._payload),L)}if(Gn(p)||Bn(p))return I!==null?null:m(f,d,p,L,null);To(f,p)}return null}function w(f,d,p,L,I){if(typeof L==="string"&&L!==""||typeof L==="number")return f=f.get(p)||null,l(d,f,""+L,I);if(typeof L==="object"&&L!==null){switch(L.$$typeof){case vo:return f=f.get(L.key===null?p:L.key)||null,u(d,f,L,I);case Wn:return f=f.get(L.key===null?p:L.key)||null,c(d,f,L,I);case $a:var T=L._init;return w(f,d,p,T(L._payload),I)}if(Gn(L)||Bn(L))return f=f.get(p)||null,m(d,f,L,I,null);To(d,L)}return null}function x(f,d,p,L){for(var I=null,T=null,F=d,y=d=0,Q=null;F!==null&&y<p.length;y++){F.index>y?(Q=F,F=null):Q=F.sibling;var D=h(f,F,p[y],L);if(D===null){F===null&&(F=Q);break}e&&F&&D.alternate===null&&a(f,F),d=o(D,d,y),T===null?I=D:T.sibling=D,T=D,F=Q}if(y===p.length)return t(f,F),ne&&It(f,y),I;if(F===null){for(;y<p.length;y++)F=g(f,p[y],L),F!==null&&(d=o(F,d,y),T===null?I=F:T.sibling=F,T=F);return ne&&It(f,y),I}for(F=n(f,F);y<p.length;y++)Q=w(F,f,y,p[y],L),Q!==null&&(e&&Q.alternate!==null&&F.delete(Q.key===null?y:Q.key),d=o(Q,d,y),T===null?I=Q:T.sibling=Q,T=Q);return e&&F.forEach(function(V){return a(f,V)}),ne&&It(f,y),I}function k(f,d,p,L){var I=Bn(p);if(typeof I!=="function")throw Error(S(150));if(p=I.call(p),p==null)throw Error(S(151));for(var T=I=null,F=d,y=d=0,Q=null,D=p.next();F!==null&&!D.done;y++,D=p.next()){F.index>y?(Q=F,F=null):Q=F.sibling;var V=h(f,F,D.value,L);if(V===null){F===null&&(F=Q);break}e&&F&&V.alternate===null&&a(f,F),d=o(V,d,y),T===null?I=V:T.sibling=V,T=V,F=Q}if(D.done)return t(f,F),ne&&It(f,y),I;if(F===null){for(;!D.done;y++,D=p.next())D=g(f,D.value,L),D!==null&&(d=o(D,d,y),T===null?I=D:T.sibling=D,T=D);return ne&&It(f,y),I}for(F=n(f,F);!D.done;y++,D=p.next())D=w(F,f,y,D.value,L),D!==null&&(e&&D.alternate!==null&&F.delete(D.key===null?y:D.key),d=o(D,d,y),T===null?I=D:T.sibling=D,T=D);return e&&F.forEach(function(oa){return a(f,oa)}),ne&&It(f,y),I}function B(f,d,p,L){if(typeof p==="object"&&p!==null&&p.type===Zt&&p.key===null&&(p=p.props.children),typeof p==="object"&&p!==null){switch(p.$$typeof){case vo:e:{for(var I=p.key,T=d;T!==null;){if(T.key===I){if(I=p.type,I===Zt){if(T.tag===7){t(f,T.sibling),d=r(T,p.props.children),d.return=f,f=d;break e}}else if(T.elementType===I||typeof I==="object"&&I!==null&&I.$$typeof===$a&&Cd(I)===T.type){t(f,T.sibling),d=r(T,p.props),d.ref=Un(f,T,p),d.return=f,f=d;break e}t(f,T);break}else a(f,T);T=T.sibling}p.type===Zt?(d=Mt(p.props.children,f.mode,L,p.key),d.return=f,f=d):(L=jo(p.type,p.key,p.props,null,f.mode,L),L.ref=Un(f,d,p),L.return=f,f=L)}return s(f);case Wn:e:{for(T=p.key;d!==null;){if(d.key===T)if(d.tag===4&&d.stateNode.containerInfo===p.containerInfo&&d.stateNode.implementation===p.implementation){t(f,d.sibling),d=r(d,p.children||[]),d.return=f,f=d;break e}else{t(f,d);break}else a(f,d);d=d.sibling}d=Ml(p,f.mode,L),d.return=f,f=d}return s(f);case $a:return T=p._init,B(f,d,T(p._payload),L)}if(Gn(p))return x(f,d,p,L);if(Bn(p))return k(f,d,p,L);To(f,p)}return typeof p==="string"&&p!==""||typeof p==="number"?(p=""+p,d!==null&&d.tag===6?(t(f,d.sibling),d=r(d,p),d.return=f,f=d):(t(f,d),d=Pl(p,f.mode,L),d.return=f,f=d),s(f)):t(f,d)}return B}function Gu(){Vu=nn=ls=null}function ju(e){var a=ss.current;te(ss),e._currentValue=a}function su(e,a,t){for(;e!==null;){var n=e.alternate;if((e.childLanes&a)!==a?(e.childLanes|=a,n!==null&&(n.childLanes|=a)):n!==null&&(n.childLanes&a)!==a&&(n.childLanes|=a),e===t)break;e=e.return}}function fn(e,a){ls=e,Vu=nn=null,e=e.dependencies,e!==null&&e.firstContext!==null&&((e.lanes&a)!==0&&(Ue=!0),e.firstContext=null)}function na(e){var a=e._currentValue;if(Vu!==e)if(e={context:e,memoizedValue:a,next:null},nn===null){if(ls===null)throw Error(S(308));nn=e,ls.dependencies={lanes:0,firstContext:e}}else nn=nn.next=e;return a}function $u(e){St===null?St=[e]:St.push(e)}function $f(e,a,t,n){var r=a.interleaved;return r===null?(t.next=t,$u(a)):(t.next=r.next,r.next=t),a.interleaved=t,qa(e,n)}function qa(e,a){e.lanes|=a;var t=e.alternate;t!==null&&(t.lanes|=a),t=e;for(e=e.return;e!==null;)e.childLanes|=a,t=e.alternate,t!==null&&(t.childLanes|=a),t=e,e=e.return;return t.tag===3?t.stateNode:null}function Ku(e){e.updateQueue={baseState:e.memoizedState,firstBaseUpdate:null,lastBaseUpdate:null,shared:{pending:null,interleaved:null,lanes:0},effects:null}}function Kf(e,a){e=e.updateQueue,a.updateQueue===e&&(a.updateQueue={baseState:e.baseState,firstBaseUpdate:e.firstBaseUpdate,lastBaseUpdate:e.lastBaseUpdate,shared:e.shared,effects:e.effects})}function Ua(e,a){return{eventTime:e,lane:a,tag:0,payload:null,callback:null,next:null}}function nt(e,a,t){var n=e.updateQueue;if(n===null)return null;if(n=n.shared,(q&2)!==0){var r=n.pending;return r===null?a.next=a:(a.next=r.next,r.next=a),n.pending=a,qa(e,t)}return r=n.interleaved,r===null?(a.next=a,$u(n)):(a.next=r.next,r.next=a),n.interleaved=a,qa(e,t)}function Uo(e,a,t){if(a=a.updateQueue,a!==null&&(a=a.shared,(t&4194240)!==0)){var n=a.lanes;n&=e.pendingLanes,t|=n,a.lanes=t,zu(e,t)}}function Sd(e,a){var t=e.updateQueue,n=e.alternate;if(n!==null&&(n=n.updateQueue,t===n)){var r=null,o=null;if(t=t.firstBaseUpdate,t!==null){do{var s={eventTime:t.eventTime,lane:t.lane,tag:t.tag,payload:t.payload,callback:t.callback,next:null};o===null?r=o=s:o=o.next=s,t=t.next}while(t!==null);o===null?r=o=a:o=o.next=a}else r=o=a;t={baseState:n.baseState,firstBaseUpdate:r,lastBaseUpdate:o,shared:n.shared,effects:n.effects},e.updateQueue=t;return}e=t.lastBaseUpdate,e===null?t.firstBaseUpdate=a:e.next=a,t.lastBaseUpdate=a}function us(e,a,t,n){var r=e.updateQueue;Ka=!1;var o=r.firstBaseUpdate,s=r.lastBaseUpdate,l=r.shared.pending;if(l!==null){r.shared.pending=null;var u=l,c=u.next;u.next=null,s===null?o=c:s.next=c,s=u;var m=e.alternate;m!==null&&(m=m.updateQueue,l=m.lastBaseUpdate,l!==s&&(l===null?m.firstBaseUpdate=c:l.next=c,m.lastBaseUpdate=u))}if(o!==null){var g=r.baseState;s=0,m=c=u=null,l=o;do{var h=l.lane,w=l.eventTime;if((n&h)===h){m!==null&&(m=m.next={eventTime:w,lane:0,tag:l.tag,payload:l.payload,callback:l.callback,next:null});e:{var x=e,k=l;switch(h=a,w=t,k.tag){case 1:if(x=k.payload,typeof x==="function"){g=x.call(w,g,h);break e}g=x;break e;case 3:x.flags=x.flags&-65537|128;case 0:if(x=k.payload,h=typeof x==="function"?x.call(w,g,h):x,h===null||h===void 0)break e;g=le({},g,h);break e;case 2:Ka=!0}}l.callback!==null&&l.lane!==0&&(e.flags|=64,h=r.effects,h===null?r.effects=[l]:h.push(l))}else w={eventTime:w,lane:h,tag:l.tag,payload:l.payload,callback:l.callback,next:null},m===null?(c=m=w,u=g):m=m.next=w,s|=h;if(l=l.next,l===null)if(l=r.shared.pending,l===null)break;else h=l,l=h.next,h.next=null,r.lastBaseUpdate=h,r.shared.pending=null}while(1);if(m===null&&(u=g),r.baseState=u,r.firstBaseUpdate=c,r.lastBaseUpdate=m,a=r.shared.interleaved,a!==null){r=a;do s|=r.lane,r=r.next;while(r!==a)}else o===null&&(r.shared.lanes=0);Tt|=s,e.lanes=s,e.memoizedState=g}}function bd(e,a,t){if(e=a.effects,a.effects=null,e!==null)for(a=0;a<e.length;a++){var n=e[a],r=n.callback;if(r!==null){if(n.callback=null,n=t,typeof r!=="function")throw Error(S(191,r));r.call(n)}}}function bt(e){if(e===br)throw Error(S(174));return e}function Xu(e,a){switch(Y(Lr,a),Y(wr,e),Y(Aa,br),e=a.nodeType,e){case 9:case 11:a=(a=a.documentElement)?a.namespaceURI:Nl(null,"");break;default:e=e===8?a.parentNode:a,a=e.namespaceURI||null,e=e.tagName,a=Nl(a,e)}te(Aa),Y(Aa,a)}function xn(){te(Aa),te(wr),te(Lr)}function Xf(e){bt(Lr.current);var a=bt(Aa.current),t=Nl(a,e.type);a!==t&&(Y(wr,e),Y(Aa,t))}function Zu(e){wr.current===e&&(te(Aa),te(wr))}function is(e){for(var a=e;a!==null;){if(a.tag===13){var t=a.memoizedState;if(t!==null&&(t=t.dehydrated,t===null||t.data==="$?"||t.data==="$!"))return a}else if(a.tag===19&&a.memoizedProps.revealOrder!==void 0){if((a.flags&128)!==0)return a}else if(a.child!==null){a.child.return=a,a=a.child;continue}if(a===e)break;for(;a.sibling===null;){if(a.return===null||a.return===e)return null;a=a.return}a.sibling.return=a.return,a=a.sibling}return null}function Qu(){for(var e=0;e<vl.length;e++)vl[e]._workInProgressVersionPrimary=null;vl.length=0}function Ae(){throw Error(S(321))}function Yu(e,a){if(a===null)return!1;for(var t=0;t<a.length&&t<e.length;t++)if(!xa(e[t],a[t]))return!1;return!0}function Ju(e,a,t,n,r,o){if(zt=o,se=a,a.memoizedState=null,a.updateQueue=null,a.lanes=0,Ho.current=e===null||e.memoizedState===null?p0:m0,e=t(n,r),rr){o=0;do{if(rr=!1,yr=0,25<=o)throw Error(S(301));o+=1,ve=xe=null,a.updateQueue=null,Ho.current=h0,e=t(n,r)}while(rr)}if(Ho.current=fs,a=xe!==null&&xe.next!==null,zt=0,ve=xe=se=null,ds=!1,a)throw Error(S(300));return e}function ei(){var e=yr!==0;return yr=0,e}function Pa(){var e={memoizedState:null,baseState:null,baseQueue:null,queue:null,next:null};return ve===null?se.memoizedState=ve=e:ve=ve.next=e,ve}function ra(){if(xe===null){var e=se.alternate;e=e!==null?e.memoizedState:null}else e=xe.next;var a=ve===null?se.memoizedState:ve.next;if(a!==null)ve=a,xe=e;else{if(e===null)throw Error(S(310));xe=e,e={memoizedState:xe.memoizedState,baseState:xe.baseState,baseQueue:xe.baseQueue,queue:xe.queue,next:null},ve===null?se.memoizedState=ve=e:ve=ve.next=e}return ve}function vr(e,a){return typeof a==="function"?a(e):a}function kl(e){var a=ra(),t=a.queue;if(t===null)throw Error(S(311));t.lastRenderedReducer=e;var n=xe,r=n.baseQueue,o=t.pending;if(o!==null){if(r!==null){var s=r.next;r.next=o.next,o.next=s}n.baseQueue=r=o,t.pending=null}if(r!==null){o=r.next,n=n.baseState;var l=s=null,u=null,c=o;do{var m=c.lane;if((zt&m)===m)u!==null&&(u=u.next={lane:0,action:c.action,hasEagerState:c.hasEagerState,eagerState:c.eagerState,next:null}),n=c.hasEagerState?c.eagerState:e(n,c.action);else{var g={lane:m,action:c.action,hasEagerState:c.hasEagerState,eagerState:c.eagerState,next:null};u===null?(l=u=g,s=n):u=u.next=g,se.lanes|=m,Tt|=m}c=c.next}while(c!==null&&c!==o);u===null?s=n:u.next=l,xa(n,a.memoizedState)||(Ue=!0),a.memoizedState=n,a.baseState=s,a.baseQueue=u,t.lastRenderedState=n}if(e=t.interleaved,e!==null){r=e;do o=r.lane,se.lanes|=o,Tt|=o,r=r.next;while(r!==e)}else r===null&&(t.lanes=0);return[a.memoizedState,t.dispatch]}function Cl(e){var a=ra(),t=a.queue;if(t===null)throw Error(S(311));t.lastRenderedReducer=e;var{dispatch:n,pending:r}=t,o=a.memoizedState;if(r!==null){t.pending=null;var s=r=r.next;do o=e(o,s.action),s=s.next;while(s!==r);xa(o,a.memoizedState)||(Ue=!0),a.memoizedState=o,a.baseQueue===null&&(a.baseState=o),t.lastRenderedState=o}return[o,n]}function Zf(){}function Qf(e,a){var t=se,n=ra(),r=a(),o=!xa(n.memoizedState,r);if(o&&(n.memoizedState=r,Ue=!0),n=n.queue,ai(ec.bind(null,t,n,e),[e]),n.getSnapshot!==a||o||ve!==null&&ve.memoizedState.tag&1){if(t.flags|=2048,Ir(9,Jf.bind(null,t,n,r,a),void 0,null),Ie===null)throw Error(S(349));(zt&30)!==0||Yf(t,a,r)}return r}function Yf(e,a,t){e.flags|=16384,e={getSnapshot:a,value:t},a=se.updateQueue,a===null?(a={lastEffect:null,stores:null},se.updateQueue=a,a.stores=[e]):(t=a.stores,t===null?a.stores=[e]:t.push(e))}function Jf(e,a,t,n){a.value=t,a.getSnapshot=n,ac(a)&&tc(e)}function ec(e,a,t){return t(function(){ac(a)&&tc(e)})}function ac(e){var a=e.getSnapshot;e=e.value;try{var t=a();return!xa(e,t)}catch(n){return!0}}function tc(e){var a=qa(e,1);a!==null&&ga(a,e,1,-1)}function Pd(e){var a=Pa();return typeof e==="function"&&(e=e()),a.memoizedState=a.baseState=e,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:vr,lastRenderedState:e},a.queue=e,e=e.dispatch=c0.bind(null,se,e),[a.memoizedState,e]}function Ir(e,a,t,n){return e={tag:e,create:a,destroy:t,deps:n,next:null},a=se.updateQueue,a===null?(a={lastEffect:null,stores:null},se.updateQueue=a,a.lastEffect=e.next=e):(t=a.lastEffect,t===null?a.lastEffect=e.next=e:(n=t.next,t.next=e,e.next=n,a.lastEffect=e)),e}function nc(){return ra().memoizedState}function qo(e,a,t,n){var r=Pa();se.flags|=e,r.memoizedState=Ir(1|a,t,void 0,n===void 0?null:n)}function Is(e,a,t,n){var r=ra();n=n===void 0?null:n;var o=void 0;if(xe!==null){var s=xe.memoizedState;if(o=s.destroy,n!==null&&Yu(n,s.deps)){r.memoizedState=Ir(a,t,o,n);return}}se.flags|=e,r.memoizedState=Ir(1|a,t,o,n)}function Md(e,a){return qo(8390656,8,e,a)}function ai(e,a){return Is(2048,8,e,a)}function rc(e,a){return Is(4,2,e,a)}function oc(e,a){return Is(4,4,e,a)}function sc(e,a){if(typeof a==="function")return e=e(),a(e),function(){a(null)};if(a!==null&&a!==void 0)return e=e(),a.current=e,function(){a.current=null}}function lc(e,a,t){return t=t!==null&&t!==void 0?t.concat([e]):null,Is(4,4,sc.bind(null,a,e),t)}function ti(){}function uc(e,a){var t=ra();a=a===void 0?null:a;var n=t.memoizedState;if(n!==null&&a!==null&&Yu(a,n[1]))return n[0];return t.memoizedState=[e,a],e}function ic(e,a){var t=ra();a=a===void 0?null:a;var n=t.memoizedState;if(n!==null&&a!==null&&Yu(a,n[1]))return n[0];return e=e(),t.memoizedState=[e,a],e}function dc(e,a,t){if((zt&21)===0)return e.baseState&&(e.baseState=!1,Ue=!0),e.memoizedState=t;return xa(t,a)||(t=hf(),se.lanes|=t,Tt|=t,e.baseState=!0),a}function d0(e,a){var t=K;K=t!==0&&4>t?t:4,e(!0);var n=Il.transition;Il.transition={};try{e(!1),a()}finally{K=t,Il.transition=n}}function fc(){return ra().memoizedState}function f0(e,a,t){var n=ot(e);if(t={lane:n,action:t,hasEagerState:!1,eagerState:null,next:null},cc(e))pc(a,t);else if(t=$f(e,a,t,n),t!==null){var r=Ee();ga(t,e,n,r),mc(t,a,n)}}function c0(e,a,t){var n=ot(e),r={lane:n,action:t,hasEagerState:!1,eagerState:null,next:null};if(cc(e))pc(a,r);else{var o=e.alternate;if(e.lanes===0&&(o===null||o.lanes===0)&&(o=a.lastRenderedReducer,o!==null))try{var s=a.lastRenderedState,l=o(s,t);if(r.hasEagerState=!0,r.eagerState=l,xa(l,s)){var u=a.interleaved;u===null?(r.next=r,$u(a)):(r.next=u.next,u.next=r),a.interleaved=r;return}}catch(c){}finally{}t=$f(e,a,r,n),t!==null&&(r=Ee(),ga(t,e,n,r),mc(t,a,n))}}function cc(e){var a=e.alternate;return e===se||a!==null&&a===se}function pc(e,a){rr=ds=!0;var t=e.pending;t===null?a.next=a:(a.next=t.next,t.next=a),e.pending=a}function mc(e,a,t){if((t&4194240)!==0){var n=a.lanes;n&=e.pendingLanes,t|=n,a.lanes=t,zu(e,t)}}function ca(e,a){if(e&&e.defaultProps){a=le({},a),e=e.defaultProps;for(var t in e)a[t]===void 0&&(a[t]=e[t]);return a}return a}function lu(e,a,t,n){a=e.memoizedState,t=t(n,a),t=t===null||t===void 0?a:le({},a,t),e.memoizedState=t,e.lanes===0&&(e.updateQueue.baseState=t)}function _d(e,a,t,n,r,o,s){return e=e.stateNode,typeof e.shouldComponentUpdate==="function"?e.shouldComponentUpdate(n,o,s):a.prototype&&a.prototype.isPureReactComponent?!hr(t,n)||!hr(r,o):!0}function hc(e,a,t){var n=!1,r=ut,o=a.contextType;return typeof o==="object"&&o!==null?o=na(o):(r=qe(a)?_t:Re.current,n=a.contextTypes,o=(n=n!==null&&n!==void 0)?mn(e,r):ut),a=new a(t,o),e.memoizedState=a.state!==null&&a.state!==void 0?a.state:null,a.updater=ks,e.stateNode=a,a._reactInternals=e,n&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=r,e.__reactInternalMemoizedMaskedChildContext=o),a}function Ad(e,a,t,n){e=a.state,typeof a.componentWillReceiveProps==="function"&&a.componentWillReceiveProps(t,n),typeof a.UNSAFE_componentWillReceiveProps==="function"&&a.UNSAFE_componentWillReceiveProps(t,n),a.state!==e&&ks.enqueueReplaceState(a,a.state,null)}function uu(e,a,t,n){var r=e.stateNode;r.props=t,r.state=e.memoizedState,r.refs={},Ku(e);var o=a.contextType;typeof o==="object"&&o!==null?r.context=na(o):(o=qe(a)?_t:Re.current,r.context=mn(e,o)),r.state=e.memoizedState,o=a.getDerivedStateFromProps,typeof o==="function"&&(lu(e,a,o,t),r.state=e.memoizedState),typeof a.getDerivedStateFromProps==="function"||typeof r.getSnapshotBeforeUpdate==="function"||typeof r.UNSAFE_componentWillMount!=="function"&&typeof r.componentWillMount!=="function"||(a=r.state,typeof r.componentWillMount==="function"&&r.componentWillMount(),typeof r.UNSAFE_componentWillMount==="function"&&r.UNSAFE_componentWillMount(),a!==r.state&&ks.enqueueReplaceState(r,r.state,null),us(e,t,r,n),r.state=e.memoizedState),typeof r.componentDidMount==="function"&&(e.flags|=4194308)}function wn(e,a){try{var t="",n=a;do t+=qm(n),n=n.return;while(n);var r=t}catch(o){r=`
Error generating stack: `+o.message+`
`+o.stack}return{value:e,source:a,stack:r,digest:null}}function Sl(e,a,t){return{value:e,source:null,stack:t!=null?t:null,digest:a!=null?a:null}}function iu(e,a){try{console.error(a.value)}catch(t){setTimeout(function(){throw t})}}function gc(e,a,t){t=Ua(-1,t),t.tag=3,t.payload={element:null};var n=a.value;return t.callback=function(){ps||(ps=!0,Lu=n),iu(e,a)},t}function xc(e,a,t){t=Ua(-1,t),t.tag=3;var n=e.type.getDerivedStateFromError;if(typeof n==="function"){var r=a.value;t.payload=function(){return n(r)},t.callback=function(){iu(e,a)}}var o=e.stateNode;return o!==null&&typeof o.componentDidCatch==="function"&&(t.callback=function(){iu(e,a),typeof n!=="function"&&(rt===null?rt=new Set([this]):rt.add(this));var s=a.stack;this.componentDidCatch(a.value,{componentStack:s!==null?s:""})}),t}function zd(e,a,t){var n=e.pingCache;if(n===null){n=e.pingCache=new g0;var r=new Set;n.set(a,r)}else r=n.get(a),r===void 0&&(r=new Set,n.set(a,r));r.has(t)||(r.add(t),e=z0.bind(null,e,a,t),a.then(e,e))}function Td(e){do{var a;if(a=e.tag===13)a=e.memoizedState,a=a!==null?a.dehydrated!==null?!0:!1:!0;if(a)return e;e=e.return}while(e!==null);return null}function Rd(e,a,t,n,r){if((e.mode&1)===0)return e===a?e.flags|=65536:(e.flags|=128,t.flags|=131072,t.flags&=-52805,t.tag===1&&(t.alternate===null?t.tag=17:(a=Ua(-1,1),a.tag=2,nt(t,a,1))),t.lanes|=1),e;return e.flags|=65536,e.lanes=r,e}function Be(e,a,t,n){a.child=e===null?jf(a,null,t,n):gn(a,e.child,t,n)}function Fd(e,a,t,n,r){t=t.render;var o=a.ref;if(fn(a,r),n=Ju(e,a,t,n,o,r),t=ei(),e!==null&&!Ue)return a.updateQueue=e.updateQueue,a.flags&=-2053,e.lanes&=~r,Wa(e,a,r);return ne&&t&&Hu(a),a.flags|=1,Be(e,a,n,r),a.child}function Dd(e,a,t,n,r){if(e===null){var o=t.type;if(typeof o==="function"&&!ii(o)&&o.defaultProps===void 0&&t.compare===null&&t.defaultProps===void 0)return a.tag=15,a.type=o,wc(e,a,o,n,r);return e=jo(t.type,null,n,a,a.mode,r),e.ref=a.ref,e.return=a,a.child=e}if(o=e.child,(e.lanes&r)===0){var s=o.memoizedProps;if(t=t.compare,t=t!==null?t:hr,t(s,n)&&e.ref===a.ref)return Wa(e,a,r)}return a.flags|=1,e=st(o,n),e.ref=a.ref,e.return=a,a.child=e}function wc(e,a,t,n,r){if(e!==null){var o=e.memoizedProps;if(hr(o,n)&&e.ref===a.ref)if(Ue=!1,a.pendingProps=n=o,(e.lanes&r)!==0)(e.flags&131072)!==0&&(Ue=!0);else return a.lanes=e.lanes,Wa(e,a,r)}return du(e,a,t,n,r)}function Lc(e,a,t){var n=a.pendingProps,r=n.children,o=e!==null?e.memoizedState:null;if(n.mode==="hidden")if((a.mode&1)===0)a.memoizedState={baseLanes:0,cachePool:null,transitions:null},Y(on,je),je|=t;else{if((t&1073741824)===0)return e=o!==null?o.baseLanes|t:t,a.lanes=a.childLanes=1073741824,a.memoizedState={baseLanes:e,cachePool:null,transitions:null},a.updateQueue=null,Y(on,je),je|=e,null;a.memoizedState={baseLanes:0,cachePool:null,transitions:null},n=o!==null?o.baseLanes:t,Y(on,je),je|=n}else o!==null?(n=o.baseLanes|t,a.memoizedState=null):n=t,Y(on,je),je|=n;return Be(e,a,r,t),a.child}function yc(e,a){var t=a.ref;if(e===null&&t!==null||e!==null&&e.ref!==t)a.flags|=512,a.flags|=2097152}function du(e,a,t,n,r){var o=qe(t)?_t:Re.current;if(o=mn(a,o),fn(a,r),t=Ju(e,a,t,n,o,r),n=ei(),e!==null&&!Ue)return a.updateQueue=e.updateQueue,a.flags&=-2053,e.lanes&=~r,Wa(e,a,r);return ne&&n&&Hu(a),a.flags|=1,Be(e,a,t,r),a.child}function Bd(e,a,t,n,r){if(qe(t)){var o=!0;ns(a)}else o=!1;if(fn(a,r),a.stateNode===null)Wo(e,a),hc(a,t,n),uu(a,t,n,r),n=!0;else if(e===null){var{stateNode:s,memoizedProps:l}=a;s.props=l;var u=s.context,c=t.contextType;typeof c==="object"&&c!==null?c=na(c):(c=qe(t)?_t:Re.current,c=mn(a,c));var m=t.getDerivedStateFromProps,g=typeof m==="function"||typeof s.getSnapshotBeforeUpdate==="function";g||typeof s.UNSAFE_componentWillReceiveProps!=="function"&&typeof s.componentWillReceiveProps!=="function"||(l!==n||u!==c)&&Ad(a,s,n,c),Ka=!1;var h=a.memoizedState;s.state=h,us(a,n,s,r),u=a.memoizedState,l!==n||h!==u||He.current||Ka?(typeof m==="function"&&(lu(a,t,m,n),u=a.memoizedState),(l=Ka||_d(a,t,l,n,h,u,c))?(g||typeof s.UNSAFE_componentWillMount!=="function"&&typeof s.componentWillMount!=="function"||(typeof s.componentWillMount==="function"&&s.componentWillMount(),typeof s.UNSAFE_componentWillMount==="function"&&s.UNSAFE_componentWillMount()),typeof s.componentDidMount==="function"&&(a.flags|=4194308)):(typeof s.componentDidMount==="function"&&(a.flags|=4194308),a.memoizedProps=n,a.memoizedState=u),s.props=n,s.state=u,s.context=c,n=l):(typeof s.componentDidMount==="function"&&(a.flags|=4194308),n=!1)}else{s=a.stateNode,Kf(e,a),l=a.memoizedProps,c=a.type===a.elementType?l:ca(a.type,l),s.props=c,g=a.pendingProps,h=s.context,u=t.contextType,typeof u==="object"&&u!==null?u=na(u):(u=qe(t)?_t:Re.current,u=mn(a,u));var w=t.getDerivedStateFromProps;(m=typeof w==="function"||typeof s.getSnapshotBeforeUpdate==="function")||typeof s.UNSAFE_componentWillReceiveProps!=="function"&&typeof s.componentWillReceiveProps!=="function"||(l!==g||h!==u)&&Ad(a,s,n,u),Ka=!1,h=a.memoizedState,s.state=h,us(a,n,s,r);var x=a.memoizedState;l!==g||h!==x||He.current||Ka?(typeof w==="function"&&(lu(a,t,w,n),x=a.memoizedState),(c=Ka||_d(a,t,c,n,h,x,u)||!1)?(m||typeof s.UNSAFE_componentWillUpdate!=="function"&&typeof s.componentWillUpdate!=="function"||(typeof s.componentWillUpdate==="function"&&s.componentWillUpdate(n,x,u),typeof s.UNSAFE_componentWillUpdate==="function"&&s.UNSAFE_componentWillUpdate(n,x,u)),typeof s.componentDidUpdate==="function"&&(a.flags|=4),typeof s.getSnapshotBeforeUpdate==="function"&&(a.flags|=1024)):(typeof s.componentDidUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(a.flags|=4),typeof s.getSnapshotBeforeUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(a.flags|=1024),a.memoizedProps=n,a.memoizedState=x),s.props=n,s.state=x,s.context=u,n=c):(typeof s.componentDidUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(a.flags|=4),typeof s.getSnapshotBeforeUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(a.flags|=1024),n=!1)}return fu(e,a,t,n,o,r)}function fu(e,a,t,n,r,o){yc(e,a);var s=(a.flags&128)!==0;if(!n&&!s)return r&&vd(a,t,!1),Wa(e,a,o);n=a.stateNode,x0.current=a;var l=s&&typeof t.getDerivedStateFromError!=="function"?null:n.render();return a.flags|=1,e!==null&&s?(a.child=gn(a,e.child,null,o),a.child=gn(a,null,l,o)):Be(e,a,l,o),a.memoizedState=n.state,r&&vd(a,t,!0),a.child}function vc(e){var a=e.stateNode;a.pendingContext?yd(e,a.pendingContext,a.pendingContext!==a.context):a.context&&yd(e,a.context,!1),Xu(e,a.containerInfo)}function Ed(e,a,t,n,r){return hn(),Wu(r),a.flags|=256,Be(e,a,t,n),a.child}function pu(e){return{baseLanes:e,cachePool:null,transitions:null}}function Ic(e,a,t){var n=a.pendingProps,r=oe.current,o=!1,s=(a.flags&128)!==0,l;if((l=s)||(l=e!==null&&e.memoizedState===null?!1:(r&2)!==0),l)o=!0,a.flags&=-129;else if(e===null||e.memoizedState!==null)r|=1;if(Y(oe,r&1),e===null){if(ou(a),e=a.memoizedState,e!==null&&(e=e.dehydrated,e!==null))return(a.mode&1)===0?a.lanes=1:e.data==="$!"?a.lanes=8:a.lanes=1073741824,null;return s=n.children,e=n.fallback,o?(n=a.mode,o=a.child,s={mode:"hidden",children:s},(n&1)===0&&o!==null?(o.childLanes=0,o.pendingProps=s):o=Ps(s,n,0,null),e=Mt(e,n,t,null),o.return=a,e.return=a,o.sibling=e,a.child=o,a.child.memoizedState=pu(t),a.memoizedState=cu,e):ni(a,s)}if(r=e.memoizedState,r!==null&&(l=r.dehydrated,l!==null))return w0(e,a,s,n,l,r,t);if(o){o=n.fallback,s=a.mode,r=e.child,l=r.sibling;var u={mode:"hidden",children:n.children};return(s&1)===0&&a.child!==r?(n=a.child,n.childLanes=0,n.pendingProps=u,a.deletions=null):(n=st(r,u),n.subtreeFlags=r.subtreeFlags&14680064),l!==null?o=st(l,o):(o=Mt(o,s,t,null),o.flags|=2),o.return=a,n.return=a,n.sibling=o,a.child=n,n=o,o=a.child,s=e.child.memoizedState,s=s===null?pu(t):{baseLanes:s.baseLanes|t,cachePool:null,transitions:s.transitions},o.memoizedState=s,o.childLanes=e.childLanes&~t,a.memoizedState=cu,n}return o=e.child,e=o.sibling,n=st(o,{mode:"visible",children:n.children}),(a.mode&1)===0&&(n.lanes=t),n.return=a,n.sibling=null,e!==null&&(t=a.deletions,t===null?(a.deletions=[e],a.flags|=16):t.push(e)),a.child=n,a.memoizedState=null,n}function ni(e,a){return a=Ps({mode:"visible",children:a},e.mode,0,null),a.return=e,e.child=a}function Ro(e,a,t,n){return n!==null&&Wu(n),gn(a,e.child,null,t),e=ni(a,a.pendingProps.children),e.flags|=2,a.memoizedState=null,e}function w0(e,a,t,n,r,o,s){if(t){if(a.flags&256)return a.flags&=-257,n=Sl(Error(S(422))),Ro(e,a,s,n);if(a.memoizedState!==null)return a.child=e.child,a.flags|=128,null;return o=n.fallback,r=a.mode,n=Ps({mode:"visible",children:n.children},r,0,null),o=Mt(o,r,s,null),o.flags|=2,n.return=a,o.return=a,n.sibling=o,a.child=n,(a.mode&1)!==0&&gn(a,e.child,null,s),a.child.memoizedState=pu(s),a.memoizedState=cu,o}if((a.mode&1)===0)return Ro(e,a,s,null);if(r.data==="$!"){if(n=r.nextSibling&&r.nextSibling.dataset,n)var l=n.dgst;return n=l,o=Error(S(419)),n=Sl(o,n,void 0),Ro(e,a,s,n)}if(l=(s&e.childLanes)!==0,Ue||l){if(n=Ie,n!==null){switch(s&-s){case 4:r=2;break;case 16:r=8;break;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:r=32;break;case 536870912:r=268435456;break;default:r=0}r=(r&(n.suspendedLanes|s))!==0?0:r,r!==0&&r!==o.retryLane&&(o.retryLane=r,qa(e,r),ga(n,e,r,-1))}return ui(),n=Sl(Error(S(421))),Ro(e,a,s,n)}if(r.data==="$?")return a.flags|=128,a.child=e.child,a=T0.bind(null,e),r._reactRetry=a,null;return e=o.treeContext,$e=tt(r.nextSibling),Ke=a,ne=!0,ma=null,e!==null&&(Je[ea++]=Na,Je[ea++]=Oa,Je[ea++]=At,Na=e.id,Oa=e.overflow,At=a),a=ni(a,n.children),a.flags|=4096,a}function Nd(e,a,t){e.lanes|=a;var n=e.alternate;n!==null&&(n.lanes|=a),su(e.return,a,t)}function bl(e,a,t,n,r){var o=e.memoizedState;o===null?e.memoizedState={isBackwards:a,rendering:null,renderingStartTime:0,last:n,tail:t,tailMode:r}:(o.isBackwards=a,o.rendering=null,o.renderingStartTime=0,o.last=n,o.tail=t,o.tailMode=r)}function kc(e,a,t){var n=a.pendingProps,r=n.revealOrder,o=n.tail;if(Be(e,a,n.children,t),n=oe.current,(n&2)!==0)n=n&1|2,a.flags|=128;else{if(e!==null&&(e.flags&128)!==0)e:for(e=a.child;e!==null;){if(e.tag===13)e.memoizedState!==null&&Nd(e,t,a);else if(e.tag===19)Nd(e,t,a);else if(e.child!==null){e.child.return=e,e=e.child;continue}if(e===a)break e;for(;e.sibling===null;){if(e.return===null||e.return===a)break e;e=e.return}e.sibling.return=e.return,e=e.sibling}n&=1}if(Y(oe,n),(a.mode&1)===0)a.memoizedState=null;else switch(r){case"forwards":t=a.child;for(r=null;t!==null;)e=t.alternate,e!==null&&is(e)===null&&(r=t),t=t.sibling;t=r,t===null?(r=a.child,a.child=null):(r=t.sibling,t.sibling=null),bl(a,!1,r,t,o);break;case"backwards":t=null,r=a.child;for(a.child=null;r!==null;){if(e=r.alternate,e!==null&&is(e)===null){a.child=r;break}e=r.sibling,r.sibling=t,t=r,r=e}bl(a,!0,t,null,o);break;case"together":bl(a,!1,null,null,void 0);break;default:a.memoizedState=null}return a.child}function Wo(e,a){(a.mode&1)===0&&e!==null&&(e.alternate=null,a.alternate=null,a.flags|=2)}function Wa(e,a,t){if(e!==null&&(a.dependencies=e.dependencies),Tt|=a.lanes,(t&a.childLanes)===0)return null;if(e!==null&&a.child!==e.child)throw Error(S(153));if(a.child!==null){e=a.child,t=st(e,e.pendingProps),a.child=t;for(t.return=a;e.sibling!==null;)e=e.sibling,t=t.sibling=st(e,e.pendingProps),t.return=a;t.sibling=null}return a.child}function L0(e,a,t){switch(a.tag){case 3:vc(a),hn();break;case 5:Xf(a);break;case 1:qe(a.type)&&ns(a);break;case 4:Xu(a,a.stateNode.containerInfo);break;case 10:var n=a.type._context,r=a.memoizedProps.value;Y(ss,n._currentValue),n._currentValue=r;break;case 13:if(n=a.memoizedState,n!==null){if(n.dehydrated!==null)return Y(oe,oe.current&1),a.flags|=128,null;if((t&a.child.childLanes)!==0)return Ic(e,a,t);return Y(oe,oe.current&1),e=Wa(e,a,t),e!==null?e.sibling:null}Y(oe,oe.current&1);break;case 19:if(n=(t&a.childLanes)!==0,(e.flags&128)!==0){if(n)return kc(e,a,t);a.flags|=128}if(r=a.memoizedState,r!==null&&(r.rendering=null,r.tail=null,r.lastEffect=null),Y(oe,oe.current),n)break;else return null;case 22:case 23:return a.lanes=0,Lc(e,a,t)}return Wa(e,a,t)}function Hn(e,a){if(!ne)switch(e.tailMode){case"hidden":a=e.tail;for(var t=null;a!==null;)a.alternate!==null&&(t=a),a=a.sibling;t===null?e.tail=null:t.sibling=null;break;case"collapsed":t=e.tail;for(var n=null;t!==null;)t.alternate!==null&&(n=t),t=t.sibling;n===null?a||e.tail===null?e.tail=null:e.tail.sibling=null:n.sibling=null}}function ze(e){var a=e.alternate!==null&&e.alternate.child===e.child,t=0,n=0;if(a)for(var r=e.child;r!==null;)t|=r.lanes|r.childLanes,n|=r.subtreeFlags&14680064,n|=r.flags&14680064,r.return=e,r=r.sibling;else for(r=e.child;r!==null;)t|=r.lanes|r.childLanes,n|=r.subtreeFlags,n|=r.flags,r.return=e,r=r.sibling;return e.subtreeFlags|=n,e.childLanes=t,a}function y0(e,a,t){var n=a.pendingProps;switch(qu(a),a.tag){case 2:case 16:case 15:case 0:case 11:case 7:case 8:case 12:case 9:case 14:return ze(a),null;case 1:return qe(a.type)&&ts(),ze(a),null;case 3:if(n=a.stateNode,xn(),te(He),te(Re),Qu(),n.pendingContext&&(n.context=n.pendingContext,n.pendingContext=null),e===null||e.child===null)zo(a)?a.flags|=4:e===null||e.memoizedState.isDehydrated&&(a.flags&256)===0||(a.flags|=1024,ma!==null&&(Iu(ma),ma=null));return mu(e,a),ze(a),null;case 5:Zu(a);var r=bt(Lr.current);if(t=a.type,e!==null&&a.stateNode!=null)Sc(e,a,t,n,r),e.ref!==a.ref&&(a.flags|=512,a.flags|=2097152);else{if(!n){if(a.stateNode===null)throw Error(S(166));return ze(a),null}if(e=bt(Aa.current),zo(a)){n=a.stateNode,t=a.type;var o=a.memoizedProps;switch(n[Ma]=a,n[xr]=o,e=(a.mode&1)!==0,t){case"dialog":ae("cancel",n),ae("close",n);break;case"iframe":case"object":case"embed":ae("load",n);break;case"video":case"audio":for(r=0;r<Qn.length;r++)ae(Qn[r],n);break;case"source":ae("error",n);break;case"img":case"image":case"link":ae("error",n),ae("load",n);break;case"details":ae("toggle",n);break;case"input":Ki(n,o),ae("invalid",n);break;case"select":n._wrapperState={wasMultiple:!!o.multiple},ae("invalid",n);break;case"textarea":Zi(n,o),ae("invalid",n)}Ol(t,o),r=null;for(var s in o)if(o.hasOwnProperty(s)){var l=o[s];s==="children"?typeof l==="string"?n.textContent!==l&&(o.suppressHydrationWarning!==!0&&Ao(n.textContent,l,e),r=["children",l]):typeof l==="number"&&n.textContent!==""+l&&(o.suppressHydrationWarning!==!0&&Ao(n.textContent,l,e),r=["children",""+l]):ur.hasOwnProperty(s)&&l!=null&&s==="onScroll"&&ae("scroll",n)}switch(t){case"input":Io(n),Xi(n,o,!0);break;case"textarea":Io(n),Qi(n);break;case"select":case"option":break;default:typeof o.onClick==="function"&&(n.onclick=as)}n=r,a.updateQueue=n,n!==null&&(a.flags|=4)}else{s=r.nodeType===9?r:r.ownerDocument,e==="http://www.w3.org/1999/xhtml"&&(e=tf(t)),e==="http://www.w3.org/1999/xhtml"?t==="script"?(e=s.createElement("div"),e.innerHTML="<script></script>",e=e.removeChild(e.firstChild)):typeof n.is==="string"?e=s.createElement(t,{is:n.is}):(e=s.createElement(t),t==="select"&&(s=e,n.multiple?s.multiple=!0:n.size&&(s.size=n.size))):e=s.createElementNS(e,t),e[Ma]=a,e[xr]=n,Cc(e,a,!1,!1),a.stateNode=e;e:{switch(s=Ul(t,n),t){case"dialog":ae("cancel",e),ae("close",e),r=n;break;case"iframe":case"object":case"embed":ae("load",e),r=n;break;case"video":case"audio":for(r=0;r<Qn.length;r++)ae(Qn[r],e);r=n;break;case"source":ae("error",e),r=n;break;case"img":case"image":case"link":ae("error",e),ae("load",e),r=n;break;case"details":ae("toggle",e),r=n;break;case"input":Ki(e,n),r=Fl(e,n),ae("invalid",e);break;case"option":r=n;break;case"select":e._wrapperState={wasMultiple:!!n.multiple},r=le({},n,{value:void 0}),ae("invalid",e);break;case"textarea":Zi(e,n),r=El(e,n),ae("invalid",e);break;default:r=n}Ol(t,r),l=r;for(o in l)if(l.hasOwnProperty(o)){var u=l[o];o==="style"?of(e,u):o==="dangerouslySetInnerHTML"?(u=u?u.__html:void 0,u!=null&&nf(e,u)):o==="children"?typeof u==="string"?(t!=="textarea"||u!=="")&&ir(e,u):typeof u==="number"&&ir(e,""+u):o!=="suppressContentEditableWarning"&&o!=="suppressHydrationWarning"&&o!=="autoFocus"&&(ur.hasOwnProperty(o)?u!=null&&o==="onScroll"&&ae("scroll",e):u!=null&&Su(e,o,u,s))}switch(t){case"input":Io(e),Xi(e,n,!1);break;case"textarea":Io(e),Qi(e);break;case"option":n.value!=null&&e.setAttribute("value",""+lt(n.value));break;case"select":e.multiple=!!n.multiple,o=n.value,o!=null?sn(e,!!n.multiple,o,!1):n.defaultValue!=null&&sn(e,!!n.multiple,n.defaultValue,!0);break;default:typeof r.onClick==="function"&&(e.onclick=as)}switch(t){case"button":case"input":case"select":case"textarea":n=!!n.autoFocus;break e;case"img":n=!0;break e;default:n=!1}}n&&(a.flags|=4)}a.ref!==null&&(a.flags|=512,a.flags|=2097152)}return ze(a),null;case 6:if(e&&a.stateNode!=null)bc(e,a,e.memoizedProps,n);else{if(typeof n!=="string"&&a.stateNode===null)throw Error(S(166));if(t=bt(Lr.current),bt(Aa.current),zo(a)){if(n=a.stateNode,t=a.memoizedProps,n[Ma]=a,o=n.nodeValue!==t){if(e=Ke,e!==null)switch(e.tag){case 3:Ao(n.nodeValue,t,(e.mode&1)!==0);break;case 5:e.memoizedProps.suppressHydrationWarning!==!0&&Ao(n.nodeValue,t,(e.mode&1)!==0)}}o&&(a.flags|=4)}else n=(t.nodeType===9?t:t.ownerDocument).createTextNode(n),n[Ma]=a,a.stateNode=n}return ze(a),null;case 13:if(te(oe),n=a.memoizedState,e===null||e.memoizedState!==null&&e.memoizedState.dehydrated!==null){if(ne&&$e!==null&&(a.mode&1)!==0&&(a.flags&128)===0)Vf(),hn(),a.flags|=98560,o=!1;else if(o=zo(a),n!==null&&n.dehydrated!==null){if(e===null){if(!o)throw Error(S(318));if(o=a.memoizedState,o=o!==null?o.dehydrated:null,!o)throw Error(S(317));o[Ma]=a}else hn(),(a.flags&128)===0&&(a.memoizedState=null),a.flags|=4;ze(a),o=!1}else ma!==null&&(Iu(ma),ma=null),o=!0;if(!o)return a.flags&65536?a:null}if((a.flags&128)!==0)return a.lanes=t,a;return n=n!==null,n!==(e!==null&&e.memoizedState!==null)&&n&&(a.child.flags|=8192,(a.mode&1)!==0&&(e===null||(oe.current&1)!==0?we===0&&(we=3):ui())),a.updateQueue!==null&&(a.flags|=4),ze(a),null;case 4:return xn(),mu(e,a),e===null&&Ou(a.stateNode.containerInfo),ze(a),null;case 10:return ju(a.type._context),ze(a),null;case 17:return qe(a.type)&&ts(),ze(a),null;case 19:if(te(oe),o=a.memoizedState,o===null)return ze(a),null;if(n=(a.flags&128)!==0,s=o.rendering,s===null)if(n)Hn(o,!1);else{if(we!==0||e!==null&&(e.flags&128)!==0)for(e=a.child;e!==null;){if(s=is(e),s!==null){a.flags|=128,Hn(o,!1),n=s.updateQueue,n!==null&&(a.updateQueue=n,a.flags|=4),a.subtreeFlags=0,n=t;for(t=a.child;t!==null;)o=t,e=n,o.flags&=14680066,s=o.alternate,s===null?(o.childLanes=0,o.lanes=e,o.child=null,o.subtreeFlags=0,o.memoizedProps=null,o.memoizedState=null,o.updateQueue=null,o.dependencies=null,o.stateNode=null):(o.childLanes=s.childLanes,o.lanes=s.lanes,o.child=s.child,o.subtreeFlags=0,o.deletions=null,o.memoizedProps=s.memoizedProps,o.memoizedState=s.memoizedState,o.updateQueue=s.updateQueue,o.type=s.type,e=s.dependencies,o.dependencies=e===null?null:{lanes:e.lanes,firstContext:e.firstContext}),t=t.sibling;return Y(oe,oe.current&1|2),a.child}e=e.sibling}o.tail!==null&&me()>Ln&&(a.flags|=128,n=!0,Hn(o,!1),a.lanes=4194304)}else{if(!n)if(e=is(s),e!==null){if(a.flags|=128,n=!0,t=e.updateQueue,t!==null&&(a.updateQueue=t,a.flags|=4),Hn(o,!0),o.tail===null&&o.tailMode==="hidden"&&!s.alternate&&!ne)return ze(a),null}else 2*me()-o.renderingStartTime>Ln&&t!==1073741824&&(a.flags|=128,n=!0,Hn(o,!1),a.lanes=4194304);o.isBackwards?(s.sibling=a.child,a.child=s):(t=o.last,t!==null?t.sibling=s:a.child=s,o.last=s)}if(o.tail!==null)return a=o.tail,o.rendering=a,o.tail=a.sibling,o.renderingStartTime=me(),a.sibling=null,t=oe.current,Y(oe,n?t&1|2:t&1),a;return ze(a),null;case 22:case 23:return li(),n=a.memoizedState!==null,e!==null&&e.memoizedState!==null!==n&&(a.flags|=8192),n&&(a.mode&1)!==0?(je&1073741824)!==0&&(ze(a),a.subtreeFlags&6&&(a.flags|=8192)):ze(a),null;case 24:return null;case 25:return null}throw Error(S(156,a.tag))}function v0(e,a){switch(qu(a),a.tag){case 1:return qe(a.type)&&ts(),e=a.flags,e&65536?(a.flags=e&-65537|128,a):null;case 3:return xn(),te(He),te(Re),Qu(),e=a.flags,(e&65536)!==0&&(e&128)===0?(a.flags=e&-65537|128,a):null;case 5:return Zu(a),null;case 13:if(te(oe),e=a.memoizedState,e!==null&&e.dehydrated!==null){if(a.alternate===null)throw Error(S(340));hn()}return e=a.flags,e&65536?(a.flags=e&-65537|128,a):null;case 19:return te(oe),null;case 4:return xn(),null;case 10:return ju(a.type._context),null;case 22:case 23:return li(),null;case 24:return null;default:return null}}function rn(e,a){var t=e.ref;if(t!==null)if(typeof t==="function")try{t(null)}catch(n){de(e,a,n)}else t.current=null}function hu(e,a,t){try{t()}catch(n){de(e,a,n)}}function k0(e,a){if(Yl=Yo,e=zf(),Nu(e)){if("selectionStart"in e)var t={start:e.selectionStart,end:e.selectionEnd};else e:{t=(t=e.ownerDocument)&&t.defaultView||window;var n=t.getSelection&&t.getSelection();if(n&&n.rangeCount!==0){t=n.anchorNode;var r=n.anchorOffset,o=n.focusNode;n=n.focusOffset;try{t.nodeType,o.nodeType}catch(L){t=null;break e}var s=0,l=-1,u=-1,c=0,m=0,g=e,h=null;a:for(;;){for(var w;;){if(g!==t||r!==0&&g.nodeType!==3||(l=s+r),g!==o||n!==0&&g.nodeType!==3||(u=s+n),g.nodeType===3&&(s+=g.nodeValue.length),(w=g.firstChild)===null)break;h=g,g=w}for(;;){if(g===e)break a;if(h===t&&++c===r&&(l=s),h===o&&++m===n&&(u=s),(w=g.nextSibling)!==null)break;g=h,h=g.parentNode}g=w}t=l===-1||u===-1?null:{start:l,end:u}}else t=null}t=t||{start:0,end:0}}else t=null;Jl={focusedElem:e,selectionRange:t},Yo=!1;for(R=a;R!==null;)if(a=R,e=a.child,(a.subtreeFlags&1028)!==0&&e!==null)e.return=a,R=e;else for(;R!==null;){a=R;try{var x=a.alternate;if((a.flags&1024)!==0)switch(a.tag){case 0:case 11:case 15:break;case 1:if(x!==null){var k=x.memoizedProps,B=x.memoizedState,f=a.stateNode,d=f.getSnapshotBeforeUpdate(a.elementType===a.type?k:ca(a.type,k),B);f.__reactInternalSnapshotBeforeUpdate=d}break;case 3:var p=a.stateNode.containerInfo;p.nodeType===1?p.textContent="":p.nodeType===9&&p.documentElement&&p.removeChild(p.documentElement);break;case 5:case 6:case 4:case 17:break;default:throw Error(S(163))}}catch(L){de(a,a.return,L)}if(e=a.sibling,e!==null){e.return=a.return,R=e;break}R=a.return}return x=Od,Od=!1,x}function or(e,a,t){var n=a.updateQueue;if(n=n!==null?n.lastEffect:null,n!==null){var r=n=n.next;do{if((r.tag&e)===e){var o=r.destroy;r.destroy=void 0,o!==void 0&&hu(a,t,o)}r=r.next}while(r!==n)}}function Cs(e,a){if(a=a.updateQueue,a=a!==null?a.lastEffect:null,a!==null){var t=a=a.next;do{if((t.tag&e)===e){var n=t.create;t.destroy=n()}t=t.next}while(t!==a)}}function gu(e){var a=e.ref;if(a!==null){var t=e.stateNode;switch(e.tag){case 5:e=t;break;default:e=t}typeof a==="function"?a(e):a.current=e}}function Pc(e){var a=e.alternate;a!==null&&(e.alternate=null,Pc(a)),e.child=null,e.deletions=null,e.sibling=null,e.tag===5&&(a=e.stateNode,a!==null&&(delete a[Ma],delete a[xr],delete a[tu],delete a[o0],delete a[s0])),e.stateNode=null,e.return=null,e.dependencies=null,e.memoizedProps=null,e.memoizedState=null,e.pendingProps=null,e.stateNode=null,e.updateQueue=null}function Mc(e){return e.tag===5||e.tag===3||e.tag===4}function Ud(e){e:for(;;){for(;e.sibling===null;){if(e.return===null||Mc(e.return))return null;e=e.return}e.sibling.return=e.return;for(e=e.sibling;e.tag!==5&&e.tag!==6&&e.tag!==18;){if(e.flags&2)continue e;if(e.child===null||e.tag===4)continue e;else e.child.return=e,e=e.child}if(!(e.flags&2))return e.stateNode}}function xu(e,a,t){var n=e.tag;if(n===5||n===6)e=e.stateNode,a?t.nodeType===8?t.parentNode.insertBefore(e,a):t.insertBefore(e,a):(t.nodeType===8?(a=t.parentNode,a.insertBefore(e,t)):(a=t,a.appendChild(e)),t=t._reactRootContainer,t!==null&&t!==void 0||a.onclick!==null||(a.onclick=as));else if(n!==4&&(e=e.child,e!==null))for(xu(e,a,t),e=e.sibling;e!==null;)xu(e,a,t),e=e.sibling}function wu(e,a,t){var n=e.tag;if(n===5||n===6)e=e.stateNode,a?t.insertBefore(e,a):t.appendChild(e);else if(n!==4&&(e=e.child,e!==null))for(wu(e,a,t),e=e.sibling;e!==null;)wu(e,a,t),e=e.sibling}function ja(e,a,t){for(t=t.child;t!==null;)_c(e,a,t),t=t.sibling}function _c(e,a,t){if(_a&&typeof _a.onCommitFiberUnmount==="function")try{_a.onCommitFiberUnmount(gs,t)}catch(l){}switch(t.tag){case 5:Te||rn(t,a);case 6:var n=be,r=pa;be=null,ja(e,a,t),be=n,pa=r,be!==null&&(pa?(e=be,t=t.stateNode,e.nodeType===8?e.parentNode.removeChild(t):e.removeChild(t)):be.removeChild(t.stateNode));break;case 18:be!==null&&(pa?(e=be,t=t.stateNode,e.nodeType===8?Ll(e.parentNode,t):e.nodeType===1&&Ll(e,t),pr(e)):Ll(be,t.stateNode));break;case 4:n=be,r=pa,be=t.stateNode.containerInfo,pa=!0,ja(e,a,t),be=n,pa=r;break;case 0:case 11:case 14:case 15:if(!Te&&(n=t.updateQueue,n!==null&&(n=n.lastEffect,n!==null))){r=n=n.next;do{var o=r,s=o.destroy;o=o.tag,s!==void 0&&((o&2)!==0?hu(t,a,s):(o&4)!==0&&hu(t,a,s)),r=r.next}while(r!==n)}ja(e,a,t);break;case 1:if(!Te&&(rn(t,a),n=t.stateNode,typeof n.componentWillUnmount==="function"))try{n.props=t.memoizedProps,n.state=t.memoizedState,n.componentWillUnmount()}catch(l){de(t,a,l)}ja(e,a,t);break;case 21:ja(e,a,t);break;case 22:t.mode&1?(Te=(n=Te)||t.memoizedState!==null,ja(e,a,t),Te=n):ja(e,a,t);break;default:ja(e,a,t)}}function Hd(e){var a=e.updateQueue;if(a!==null){e.updateQueue=null;var t=e.stateNode;t===null&&(t=e.stateNode=new I0),a.forEach(function(n){var r=R0.bind(null,e,n);t.has(n)||(t.add(n),n.then(r,r))})}}function fa(e,a){var t=a.deletions;if(t!==null)for(var n=0;n<t.length;n++){var r=t[n];try{var o=e,s=a,l=s;e:for(;l!==null;){switch(l.tag){case 5:be=l.stateNode,pa=!1;break e;case 3:be=l.stateNode.containerInfo,pa=!0;break e;case 4:be=l.stateNode.containerInfo,pa=!0;break e}l=l.return}if(be===null)throw Error(S(160));_c(o,s,r),be=null,pa=!1;var u=r.alternate;u!==null&&(u.return=null),r.return=null}catch(c){de(r,a,c)}}if(a.subtreeFlags&12854)for(a=a.child;a!==null;)Ac(a,e),a=a.sibling}function Ac(e,a){var{alternate:t,flags:n}=e;switch(e.tag){case 0:case 11:case 14:case 15:if(fa(a,e),ba(e),n&4){try{or(3,e,e.return),Cs(3,e)}catch(k){de(e,e.return,k)}try{or(5,e,e.return)}catch(k){de(e,e.return,k)}}break;case 1:fa(a,e),ba(e),n&512&&t!==null&&rn(t,t.return);break;case 5:if(fa(a,e),ba(e),n&512&&t!==null&&rn(t,t.return),e.flags&32){var r=e.stateNode;try{ir(r,"")}catch(k){de(e,e.return,k)}}if(n&4&&(r=e.stateNode,r!=null)){var o=e.memoizedProps,s=t!==null?t.memoizedProps:o,{type:l,updateQueue:u}=e;if(e.updateQueue=null,u!==null)try{l==="input"&&o.type==="radio"&&o.name!=null&&ef(r,o),Ul(l,s);var c=Ul(l,o);for(s=0;s<u.length;s+=2){var m=u[s],g=u[s+1];m==="style"?of(r,g):m==="dangerouslySetInnerHTML"?nf(r,g):m==="children"?ir(r,g):Su(r,m,g,c)}switch(l){case"input":Dl(r,o);break;case"textarea":af(r,o);break;case"select":var h=r._wrapperState.wasMultiple;r._wrapperState.wasMultiple=!!o.multiple;var w=o.value;w!=null?sn(r,!!o.multiple,w,!1):h!==!!o.multiple&&(o.defaultValue!=null?sn(r,!!o.multiple,o.defaultValue,!0):sn(r,!!o.multiple,o.multiple?[]:"",!1))}r[xr]=o}catch(k){de(e,e.return,k)}}break;case 6:if(fa(a,e),ba(e),n&4){if(e.stateNode===null)throw Error(S(162));r=e.stateNode,o=e.memoizedProps;try{r.nodeValue=o}catch(k){de(e,e.return,k)}}break;case 3:if(fa(a,e),ba(e),n&4&&t!==null&&t.memoizedState.isDehydrated)try{pr(a.containerInfo)}catch(k){de(e,e.return,k)}break;case 4:fa(a,e),ba(e);break;case 13:fa(a,e),ba(e),r=e.child,r.flags&8192&&(o=r.memoizedState!==null,r.stateNode.isHidden=o,!o||r.alternate!==null&&r.alternate.memoizedState!==null||(si=me())),n&4&&Hd(e);break;case 22:if(m=t!==null&&t.memoizedState!==null,e.mode&1?(Te=(c=Te)||m,fa(a,e),Te=c):fa(a,e),ba(e),n&8192){if(c=e.memoizedState!==null,(e.stateNode.isHidden=c)&&!m&&(e.mode&1)!==0)for(R=e,m=e.child;m!==null;){for(g=R=m;R!==null;){switch(h=R,w=h.child,h.tag){case 0:case 11:case 14:case 15:or(4,h,h.return);break;case 1:rn(h,h.return);var x=h.stateNode;if(typeof x.componentWillUnmount==="function"){n=h,t=h.return;try{a=n,x.props=a.memoizedProps,x.state=a.memoizedState,x.componentWillUnmount()}catch(k){de(n,t,k)}}break;case 5:rn(h,h.return);break;case 22:if(h.memoizedState!==null){Wd(g);continue}}w!==null?(w.return=h,R=w):Wd(g)}m=m.sibling}e:for(m=null,g=e;;){if(g.tag===5){if(m===null){m=g;try{r=g.stateNode,c?(o=r.style,typeof o.setProperty==="function"?o.setProperty("display","none","important"):o.display="none"):(l=g.stateNode,u=g.memoizedProps.style,s=u!==void 0&&u!==null&&u.hasOwnProperty("display")?u.display:null,l.style.display=rf("display",s))}catch(k){de(e,e.return,k)}}}else if(g.tag===6){if(m===null)try{g.stateNode.nodeValue=c?"":g.memoizedProps}catch(k){de(e,e.return,k)}}else if((g.tag!==22&&g.tag!==23||g.memoizedState===null||g===e)&&g.child!==null){g.child.return=g,g=g.child;continue}if(g===e)break e;for(;g.sibling===null;){if(g.return===null||g.return===e)break e;m===g&&(m=null),g=g.return}m===g&&(m=null),g.sibling.return=g.return,g=g.sibling}}break;case 19:fa(a,e),ba(e),n&4&&Hd(e);break;case 21:break;default:fa(a,e),ba(e)}}function ba(e){var a=e.flags;if(a&2){try{e:{for(var t=e.return;t!==null;){if(Mc(t)){var n=t;break e}t=t.return}throw Error(S(160))}switch(n.tag){case 5:var r=n.stateNode;n.flags&32&&(ir(r,""),n.flags&=-33);var o=Ud(e);wu(e,o,r);break;case 3:case 4:var s=n.stateNode.containerInfo,l=Ud(e);xu(e,l,s);break;default:throw Error(S(161))}}catch(u){de(e,e.return,u)}e.flags&=-3}a&4096&&(e.flags&=-4097)}function C0(e,a,t){R=e,zc(e,a,t)}function zc(e,a,t){for(var n=(e.mode&1)!==0;R!==null;){var r=R,o=r.child;if(r.tag===22&&n){var s=r.memoizedState!==null||Fo;if(!s){var l=r.alternate,u=l!==null&&l.memoizedState!==null||Te;l=Fo;var c=Te;if(Fo=s,(Te=u)&&!c)for(R=r;R!==null;)s=R,u=s.child,s.tag===22&&s.memoizedState!==null?Vd(r):u!==null?(u.return=s,R=u):Vd(r);for(;o!==null;)R=o,zc(o,a,t),o=o.sibling;R=r,Fo=l,Te=c}qd(e,a,t)}else(r.subtreeFlags&8772)!==0&&o!==null?(o.return=r,R=o):qd(e,a,t)}}function qd(e){for(;R!==null;){var a=R;if((a.flags&8772)!==0){var t=a.alternate;try{if((a.flags&8772)!==0)switch(a.tag){case 0:case 11:case 15:Te||Cs(5,a);break;case 1:var n=a.stateNode;if(a.flags&4&&!Te)if(t===null)n.componentDidMount();else{var r=a.elementType===a.type?t.memoizedProps:ca(a.type,t.memoizedProps);n.componentDidUpdate(r,t.memoizedState,n.__reactInternalSnapshotBeforeUpdate)}var o=a.updateQueue;o!==null&&bd(a,o,n);break;case 3:var s=a.updateQueue;if(s!==null){if(t=null,a.child!==null)switch(a.child.tag){case 5:t=a.child.stateNode;break;case 1:t=a.child.stateNode}bd(a,s,t)}break;case 5:var l=a.stateNode;if(t===null&&a.flags&4){t=l;var u=a.memoizedProps;switch(a.type){case"button":case"input":case"select":case"textarea":u.autoFocus&&t.focus();break;case"img":u.src&&(t.src=u.src)}}break;case 6:break;case 4:break;case 12:break;case 13:if(a.memoizedState===null){var c=a.alternate;if(c!==null){var m=c.memoizedState;if(m!==null){var g=m.dehydrated;g!==null&&pr(g)}}}break;case 19:case 17:case 21:case 22:case 23:case 25:break;default:throw Error(S(163))}Te||a.flags&512&&gu(a)}catch(h){de(a,a.return,h)}}if(a===e){R=null;break}if(t=a.sibling,t!==null){t.return=a.return,R=t;break}R=a.return}}function Wd(e){for(;R!==null;){var a=R;if(a===e){R=null;break}var t=a.sibling;if(t!==null){t.return=a.return,R=t;break}R=a.return}}function Vd(e){for(;R!==null;){var a=R;try{switch(a.tag){case 0:case 11:case 15:var t=a.return;try{Cs(4,a)}catch(u){de(a,t,u)}break;case 1:var n=a.stateNode;if(typeof n.componentDidMount==="function"){var r=a.return;try{n.componentDidMount()}catch(u){de(a,r,u)}}var o=a.return;try{gu(a)}catch(u){de(a,o,u)}break;case 5:var s=a.return;try{gu(a)}catch(u){de(a,s,u)}}}catch(u){de(a,a.return,u)}if(a===e){R=null;break}var l=a.sibling;if(l!==null){l.return=a.return,R=l;break}R=a.return}}function Ee(){return(q&6)!==0?me():Vo!==-1?Vo:Vo=me()}function ot(e){if((e.mode&1)===0)return 1;if((q&2)!==0&&Pe!==0)return Pe&-Pe;if(u0.transition!==null)return Go===0&&(Go=hf()),Go;if(e=K,e!==0)return e;return e=window.event,e=e===void 0?16:If(e.type),e}function ga(e,a,t,n){if(50<lr)throw lr=0,yu=null,Error(S(185));if(Cr(e,t,n),(q&2)===0||e!==Ie)e===Ie&&((q&2)===0&&(Ss|=t),we===4&&Za(e,Pe)),We(e,n),t===1&&q===0&&(a.mode&1)===0&&(Ln=me()+500,vs&&ft())}function We(e,a){var t=e.callbackNode;dh(e,a);var n=Qo(e,e===Ie?Pe:0);if(n===0)t!==null&&ed(t),e.callbackNode=null,e.callbackPriority=0;else if(a=n&-n,e.callbackPriority!==a){if(t!=null&&ed(t),a===1)e.tag===0?l0(Gd.bind(null,e)):Hf(Gd.bind(null,e)),n0(function(){(q&6)===0&&ft()}),t=null;else{switch(gf(n)){case 1:t=Au;break;case 4:t=pf;break;case 16:t=Zo;break;case 536870912:t=mf;break;default:t=Zo}t=Oc(t,Tc.bind(null,e))}e.callbackPriority=a,e.callbackNode=t}}function Tc(e,a){if(Vo=-1,Go=0,(q&6)!==0)throw Error(S(327));var t=e.callbackNode;if(cn()&&e.callbackNode!==t)return null;var n=Qo(e,e===Ie?Pe:0);if(n===0)return null;if((n&30)!==0||(n&e.expiredLanes)!==0||a)a=hs(e,n);else{a=n;var r=q;q|=2;var o=Fc();if(Ie!==e||Pe!==a)Ba=null,Ln=me()+500,Pt(e,a);do try{_0();break}catch(l){Rc(e,l)}while(1);Gu(),cs.current=o,q=r,ge!==null?a=0:(Ie=null,Pe=0,a=we)}if(a!==0){if(a===2&&(r=Gl(e),r!==0&&(n=r,a=vu(e,r))),a===1)throw t=kr,Pt(e,0),Za(e,n),We(e,me()),t;if(a===6)Za(e,n);else{if(r=e.current.alternate,(n&30)===0&&!b0(r)&&(a=hs(e,n),a===2&&(o=Gl(e),o!==0&&(n=o,a=vu(e,o))),a===1))throw t=kr,Pt(e,0),Za(e,n),We(e,me()),t;switch(e.finishedWork=r,e.finishedLanes=n,a){case 0:case 1:throw Error(S(345));case 2:kt(e,Oe,Ba);break;case 3:if(Za(e,n),(n&130023424)===n&&(a=si+500-me(),10<a)){if(Qo(e,0)!==0)break;if(r=e.suspendedLanes,(r&n)!==n){Ee(),e.pingedLanes|=e.suspendedLanes&r;break}e.timeoutHandle=au(kt.bind(null,e,Oe,Ba),a);break}kt(e,Oe,Ba);break;case 4:if(Za(e,n),(n&4194240)===n)break;a=e.eventTimes;for(r=-1;0<n;){var s=31-ha(n);o=1<<s,s=a[s],s>r&&(r=s),n&=~o}if(n=r,n=me()-n,n=(120>n?120:480>n?480:1080>n?1080:1920>n?1920:3000>n?3000:4320>n?4320:1960*S0(n/1960))-n,10<n){e.timeoutHandle=au(kt.bind(null,e,Oe,Ba),n);break}kt(e,Oe,Ba);break;case 5:kt(e,Oe,Ba);break;default:throw Error(S(329))}}}return We(e,me()),e.callbackNode===t?Tc.bind(null,e):null}function vu(e,a){var t=sr;return e.current.memoizedState.isDehydrated&&(Pt(e,a).flags|=256),e=hs(e,a),e!==2&&(a=Oe,Oe=t,a!==null&&Iu(a)),e}function Iu(e){Oe===null?Oe=e:Oe.push.apply(Oe,e)}function b0(e){for(var a=e;;){if(a.flags&16384){var t=a.updateQueue;if(t!==null&&(t=t.stores,t!==null))for(var n=0;n<t.length;n++){var r=t[n],o=r.getSnapshot;r=r.value;try{if(!xa(o(),r))return!1}catch(s){return!1}}}if(t=a.child,a.subtreeFlags&16384&&t!==null)t.return=a,a=t;else{if(a===e)break;for(;a.sibling===null;){if(a.return===null||a.return===e)return!0;a=a.return}a.sibling.return=a.return,a=a.sibling}}return!0}function Za(e,a){a&=~oi,a&=~Ss,e.suspendedLanes|=a,e.pingedLanes&=~a;for(e=e.expirationTimes;0<a;){var t=31-ha(a),n=1<<t;e[t]=-1,a&=~n}}function Gd(e){if((q&6)!==0)throw Error(S(327));cn();var a=Qo(e,0);if((a&1)===0)return We(e,me()),null;var t=hs(e,a);if(e.tag!==0&&t===2){var n=Gl(e);n!==0&&(a=n,t=vu(e,n))}if(t===1)throw t=kr,Pt(e,0),Za(e,a),We(e,me()),t;if(t===6)throw Error(S(345));return e.finishedWork=e.current.alternate,e.finishedLanes=a,kt(e,Oe,Ba),We(e,me()),null}function P0(e,a){var t=q;q|=1;try{return e(a)}finally{q=t,q===0&&(Ln=me()+500,vs&&ft())}}function bs(e){Ya!==null&&Ya.tag===0&&(q&6)===0&&cn();var a=q;q|=1;var t=ta.transition,n=K;try{if(ta.transition=null,K=1,e)return e()}finally{K=n,ta.transition=t,q=a,(q&6)===0&&ft()}}function li(){je=on.current,te(on)}function Pt(e,a){e.finishedWork=null,e.finishedLanes=0;var t=e.timeoutHandle;if(t!==-1&&(e.timeoutHandle=-1,t0(t)),ge!==null)for(t=ge.return;t!==null;){var n=t;switch(qu(n),n.tag){case 1:n=n.type.childContextTypes,n!==null&&n!==void 0&&ts();break;case 3:xn(),te(He),te(Re),Qu();break;case 5:Zu(n);break;case 4:xn();break;case 13:te(oe);break;case 19:te(oe);break;case 10:ju(n.type._context);break;case 22:case 23:li()}t=t.return}if(Ie=e,ge=e=st(e.current,null),Pe=je=a,we=0,kr=null,oi=Ss=Tt=0,Oe=sr=null,St!==null){for(a=0;a<St.length;a++)if(t=St[a],n=t.interleaved,n!==null){t.interleaved=null;var r=n.next,o=t.pending;if(o!==null){var s=o.next;o.next=r,n.next=s}t.pending=n}St=null}return e}function Rc(e,a){do{var t=ge;try{if(Gu(),Ho.current=fs,ds){for(var n=se.memoizedState;n!==null;){var r=n.queue;r!==null&&(r.pending=null),n=n.next}ds=!1}if(zt=0,ve=xe=se=null,rr=!1,yr=0,ri.current=null,t===null||t.return===null){we=1,kr=a,ge=null;break}e:{var o=e,s=t.return,l=t,u=a;if(a=Pe,l.flags|=32768,u!==null&&typeof u==="object"&&typeof u.then==="function"){var c=u,m=l,g=m.tag;if((m.mode&1)===0&&(g===0||g===11||g===15)){var h=m.alternate;h?(m.updateQueue=h.updateQueue,m.memoizedState=h.memoizedState,m.lanes=h.lanes):(m.updateQueue=null,m.memoizedState=null)}var w=Td(s);if(w!==null){w.flags&=-257,Rd(w,s,l,o,a),w.mode&1&&zd(o,c,a),a=w,u=c;var x=a.updateQueue;if(x===null){var k=new Set;k.add(u),a.updateQueue=k}else x.add(u);break e}else{if((a&1)===0){zd(o,c,a),ui();break e}u=Error(S(426))}}else if(ne&&l.mode&1){var B=Td(s);if(B!==null){(B.flags&65536)===0&&(B.flags|=256),Rd(B,s,l,o,a),Wu(wn(u,l));break e}}o=u=wn(u,l),we!==4&&(we=2),sr===null?sr=[o]:sr.push(o),o=s;do{switch(o.tag){case 3:o.flags|=65536,a&=-a,o.lanes|=a;var f=gc(o,u,a);Sd(o,f);break e;case 1:l=u;var d=o.type,p=o.stateNode;if((o.flags&128)===0&&(typeof d.getDerivedStateFromError==="function"||p!==null&&typeof p.componentDidCatch==="function"&&(rt===null||!rt.has(p)))){o.flags|=65536,a&=-a,o.lanes|=a;var L=xc(o,l,a);Sd(o,L);break e}}o=o.return}while(o!==null)}Bc(t)}catch(I){a=I,ge===t&&t!==null&&(ge=t=t.return);continue}break}while(1)}function Fc(){var e=cs.current;return cs.current=fs,e===null?fs:e}function ui(){if(we===0||we===3||we===2)we=4;Ie===null||(Tt&268435455)===0&&(Ss&268435455)===0||Za(Ie,Pe)}function hs(e,a){var t=q;q|=2;var n=Fc();if(Ie!==e||Pe!==a)Ba=null,Pt(e,a);do try{M0();break}catch(r){Rc(e,r)}while(1);if(Gu(),q=t,cs.current=n,ge!==null)throw Error(S(261));return Ie=null,Pe=0,we}function M0(){for(;ge!==null;)Dc(ge)}function _0(){for(;ge!==null&&!ah();)Dc(ge)}function Dc(e){var a=Nc(e.alternate,e,je);e.memoizedProps=e.pendingProps,a===null?Bc(e):ge=a,ri.current=null}function Bc(e){var a=e;do{var t=a.alternate;if(e=a.return,(a.flags&32768)===0){if(t=y0(t,a,je),t!==null){ge=t;return}}else{if(t=v0(t,a),t!==null){t.flags&=32767,ge=t;return}if(e!==null)e.flags|=32768,e.subtreeFlags=0,e.deletions=null;else{we=6,ge=null;return}}if(a=a.sibling,a!==null){ge=a;return}ge=a=e}while(a!==null);we===0&&(we=5)}function kt(e,a,t){var n=K,r=ta.transition;try{ta.transition=null,K=1,A0(e,a,t,n)}finally{ta.transition=r,K=n}return null}function A0(e,a,t,n){do cn();while(Ya!==null);if((q&6)!==0)throw Error(S(327));t=e.finishedWork;var r=e.finishedLanes;if(t===null)return null;if(e.finishedWork=null,e.finishedLanes=0,t===e.current)throw Error(S(177));e.callbackNode=null,e.callbackPriority=0;var o=t.lanes|t.childLanes;if(fh(e,o),e===Ie&&(ge=Ie=null,Pe=0),(t.subtreeFlags&2064)===0&&(t.flags&2064)===0||Do||(Do=!0,Oc(Zo,function(){return cn(),null})),o=(t.flags&15990)!==0,(t.subtreeFlags&15990)!==0||o){o=ta.transition,ta.transition=null;var s=K;K=1;var l=q;q|=4,ri.current=null,k0(e,t),Ac(t,e),Qh(Jl),Yo=!!Yl,Jl=Yl=null,e.current=t,C0(t,e,r),th(),q=l,K=s,ta.transition=o}else e.current=t;if(Do&&(Do=!1,Ya=e,ms=r),o=e.pendingLanes,o===0&&(rt=null),oh(t.stateNode,n),We(e,me()),a!==null)for(n=e.onRecoverableError,t=0;t<a.length;t++)r=a[t],n(r.value,{componentStack:r.stack,digest:r.digest});if(ps)throw ps=!1,e=Lu,Lu=null,e;return(ms&1)!==0&&e.tag!==0&&cn(),o=e.pendingLanes,(o&1)!==0?e===yu?lr++:(lr=0,yu=e):lr=0,ft(),null}function cn(){if(Ya!==null){var e=gf(ms),a=ta.transition,t=K;try{if(ta.transition=null,K=16>e?16:e,Ya===null)var n=!1;else{if(e=Ya,Ya=null,ms=0,(q&6)!==0)throw Error(S(331));var r=q;q|=4;for(R=e.current;R!==null;){var o=R,s=o.child;if((R.flags&16)!==0){var l=o.deletions;if(l!==null){for(var u=0;u<l.length;u++){var c=l[u];for(R=c;R!==null;){var m=R;switch(m.tag){case 0:case 11:case 15:or(8,m,o)}var g=m.child;if(g!==null)g.return=m,R=g;else for(;R!==null;){m=R;var h=m.sibling,w=m.return;if(Pc(m),m===c){R=null;break}if(h!==null){h.return=w,R=h;break}R=w}}}var x=o.alternate;if(x!==null){var k=x.child;if(k!==null){x.child=null;do{var B=k.sibling;k.sibling=null,k=B}while(k!==null)}}R=o}}if((o.subtreeFlags&2064)!==0&&s!==null)s.return=o,R=s;else e:for(;R!==null;){if(o=R,(o.flags&2048)!==0)switch(o.tag){case 0:case 11:case 15:or(9,o,o.return)}var f=o.sibling;if(f!==null){f.return=o.return,R=f;break e}R=o.return}}var d=e.current;for(R=d;R!==null;){s=R;var p=s.child;if((s.subtreeFlags&2064)!==0&&p!==null)p.return=s,R=p;else e:for(s=d;R!==null;){if(l=R,(l.flags&2048)!==0)try{switch(l.tag){case 0:case 11:case 15:Cs(9,l)}}catch(I){de(l,l.return,I)}if(l===s){R=null;break e}var L=l.sibling;if(L!==null){L.return=l.return,R=L;break e}R=l.return}}if(q=r,ft(),_a&&typeof _a.onPostCommitFiberRoot==="function")try{_a.onPostCommitFiberRoot(gs,e)}catch(I){}n=!0}return n}finally{K=t,ta.transition=a}}return!1}function jd(e,a,t){a=wn(t,a),a=gc(e,a,1),e=nt(e,a,1),a=Ee(),e!==null&&(Cr(e,1,a),We(e,a))}function de(e,a,t){if(e.tag===3)jd(e,e,t);else for(;a!==null;){if(a.tag===3){jd(a,e,t);break}else if(a.tag===1){var n=a.stateNode;if(typeof a.type.getDerivedStateFromError==="function"||typeof n.componentDidCatch==="function"&&(rt===null||!rt.has(n))){e=wn(t,e),e=xc(a,e,1),a=nt(a,e,1),e=Ee(),a!==null&&(Cr(a,1,e),We(a,e));break}}a=a.return}}function z0(e,a,t){var n=e.pingCache;n!==null&&n.delete(a),a=Ee(),e.pingedLanes|=e.suspendedLanes&t,Ie===e&&(Pe&t)===t&&(we===4||we===3&&(Pe&130023424)===Pe&&500>me()-si?Pt(e,0):oi|=t),We(e,a)}function Ec(e,a){a===0&&((e.mode&1)===0?a=1:(a=So,So<<=1,(So&130023424)===0&&(So=4194304)));var t=Ee();e=qa(e,a),e!==null&&(Cr(e,a,t),We(e,t))}function T0(e){var a=e.memoizedState,t=0;a!==null&&(t=a.retryLane),Ec(e,t)}function R0(e,a){var t=0;switch(e.tag){case 13:var{stateNode:n,memoizedState:r}=e;r!==null&&(t=r.retryLane);break;case 19:n=e.stateNode;break;default:throw Error(S(314))}n!==null&&n.delete(a),Ec(e,t)}function Oc(e,a){return cf(e,a)}function F0(e,a,t,n){this.tag=e,this.key=t,this.sibling=this.child=this.return=this.stateNode=this.type=this.elementType=null,this.index=0,this.ref=null,this.pendingProps=a,this.dependencies=this.memoizedState=this.updateQueue=this.memoizedProps=null,this.mode=n,this.subtreeFlags=this.flags=0,this.deletions=null,this.childLanes=this.lanes=0,this.alternate=null}function aa(e,a,t,n){return new F0(e,a,t,n)}function ii(e){return e=e.prototype,!(!e||!e.isReactComponent)}function D0(e){if(typeof e==="function")return ii(e)?1:0;if(e!==void 0&&e!==null){if(e=e.$$typeof,e===Pu)return 11;if(e===Mu)return 14}return 2}function st(e,a){var t=e.alternate;return t===null?(t=aa(e.tag,a,e.key,e.mode),t.elementType=e.elementType,t.type=e.type,t.stateNode=e.stateNode,t.alternate=e,e.alternate=t):(t.pendingProps=a,t.type=e.type,t.flags=0,t.subtreeFlags=0,t.deletions=null),t.flags=e.flags&14680064,t.childLanes=e.childLanes,t.lanes=e.lanes,t.child=e.child,t.memoizedProps=e.memoizedProps,t.memoizedState=e.memoizedState,t.updateQueue=e.updateQueue,a=e.dependencies,t.dependencies=a===null?null:{lanes:a.lanes,firstContext:a.firstContext},t.sibling=e.sibling,t.index=e.index,t.ref=e.ref,t}function jo(e,a,t,n,r,o){var s=2;if(n=e,typeof e==="function")ii(e)&&(s=1);else if(typeof e==="string")s=5;else e:switch(e){case Zt:return Mt(t.children,r,o,a);case bu:s=8,r|=8;break;case Al:return e=aa(12,t,a,r|2),e.elementType=Al,e.lanes=o,e;case zl:return e=aa(13,t,a,r),e.elementType=zl,e.lanes=o,e;case Tl:return e=aa(19,t,a,r),e.elementType=Tl,e.lanes=o,e;case Qd:return Ps(t,r,o,a);default:if(typeof e==="object"&&e!==null)switch(e.$$typeof){case Xd:s=10;break e;case Zd:s=9;break e;case Pu:s=11;break e;case Mu:s=14;break e;case $a:s=16,n=null;break e}throw Error(S(130,e==null?e:typeof e,""))}return a=aa(s,t,a,r),a.elementType=e,a.type=n,a.lanes=o,a}function Mt(e,a,t,n){return e=aa(7,e,n,a),e.lanes=t,e}function Ps(e,a,t,n){return e=aa(22,e,n,a),e.elementType=Qd,e.lanes=t,e.stateNode={isHidden:!1},e}function Pl(e,a,t){return e=aa(6,e,null,a),e.lanes=t,e}function Ml(e,a,t){return a=aa(4,e.children!==null?e.children:[],e.key,a),a.lanes=t,a.stateNode={containerInfo:e.containerInfo,pendingChildren:null,implementation:e.implementation},a}function B0(e,a,t,n,r){this.tag=a,this.containerInfo=e,this.finishedWork=this.pingCache=this.current=this.pendingChildren=null,this.timeoutHandle=-1,this.callbackNode=this.pendingContext=this.context=null,this.callbackPriority=0,this.eventTimes=cl(0),this.expirationTimes=cl(-1),this.entangledLanes=this.finishedLanes=this.mutableReadLanes=this.expiredLanes=this.pingedLanes=this.suspendedLanes=this.pendingLanes=0,this.entanglements=cl(0),this.identifierPrefix=n,this.onRecoverableError=r,this.mutableSourceEagerHydrationData=null}function Uc(e,a,t,n,r,o,s,l,u){return e=new B0(e,a,t,l,u),a===1?(a=1,o===!0&&(a|=8)):a=0,o=aa(3,null,null,a),e.current=o,o.stateNode=e,o.memoizedState={element:n,isDehydrated:t,cache:null,transitions:null,pendingSuspenseBoundaries:null},Ku(o),e}function Hc(e){if(!e)return ut;e=e._reactInternals;e:{if(Ft(e)!==e||e.tag!==1)throw Error(S(170));var a=e;do{switch(a.tag){case 3:a=a.stateNode.context;break e;case 1:if(qe(a.type)){a=a.stateNode.__reactInternalMemoizedMergedChildContext;break e}}a=a.return}while(a!==null);throw Error(S(171))}if(e.tag===1){var t=e.type;if(qe(t))return Uf(e,t,a)}return a}function E0(e,a,t,n,r,o,s,l,u){return e=Uc(t,n,!0,e,r,o,s,l,u),e.context=Hc(null),t=e.current,n=Ee(),r=ot(t),o=Ua(n,r),o.callback=a!==void 0&&a!==null?a:null,nt(t,o,r),e.current.lanes=r,Cr(e,r,n),We(e,n),e}function qc(e,a,t,n){var r=a.current,o=Ee(),s=ot(r);return t=Hc(t),a.context===null?a.context=t:a.pendingContext=t,a=Ua(o,s),a.payload={element:e},n=n===void 0?null:n,n!==null&&(a.callback=n),e=nt(r,a,s),e!==null&&(ga(e,r,s,o),Uo(e,r,s)),s}function $d(e,a){if(e=e.memoizedState,e!==null&&e.dehydrated!==null){var t=e.retryLane;e.retryLane=t!==0&&t<a?t:a}}function di(e,a){$d(e,a),(e=e.alternate)&&$d(e,a)}function N0(){return null}function fi(e){this._internalRoot=e}function Ms(e){this._internalRoot=e}function Vc(e){return!(!e||e.nodeType!==1&&e.nodeType!==9&&e.nodeType!==11)}var re,Kd,ur,Ha,_l,Nm,Gi,ji,Me,ku,Va,vo,Wn,Zt,bu,Al,Xd,Zd,Pu,zl,Tl,Mu,$a,Qd,$i,le,ul,il=!1,Gn,ko,nf,Jn,Gm,jm,Hl=null,ql=null,ln=null,un=null,fl=!1,Wl=!1,vt,er=!1,Ko=null,Xo=!1,Vl=null,Zm,cf,ed,ah,th,me,nh,Au,pf,Zo,rh,mf,gs=null,_a=null,ha,sh,lh,Co=64,So=4194304,K=0,xf,Tu,wf,Lf,yf,jl=!1,bo,Ja=null,et=null,at=null,fr,cr,Xa,ch,dn,Yo=!0,Jo=null,Qa=null,Fu=null,Eo=null,yn,Du,Sr,xh,pl,ml,On,xs,rd,wh,Lh,yh,hl,vh,Ih,kh,Ch,Sh,od,bh,Ph,Mh,Ah,zh,Th,sd,Rh,Fh,Dh,Bh,Eh,Nh,Oh,Eu,ar=null,Uh,Cf,ld,ud=!1,Qt=!1,Wh,tr=null,mr=null,Mf=!1,$n,Kn,Oo,xa,Yh,Yt=null,Kl=null,nr=null,Xl=!1,Jt,gl,Tf,Rf,Ff,Df,Bf,Ef,md,Zn,Zl,Ql,Xn,Qn,Jh,_o,e0,a0,Yl=null,Jl=null,au,t0,wd,n0,vn,Ma,xr,In,tu,o0,s0,nu,en=-1,ut,Re,He,_t,Ea=null,vs=!1,yl=!1,an,tn=0,rs=null,os=0,Je,ea=0,At=null,Na=1,Oa="",Ke=null,$e=null,ne=!1,ma=null,u0,gn,jf,ss,ls=null,nn=null,Vu=null,St=null,Ka=!1,br,Aa,wr,Lr,oe,vl,Ho,Il,zt=0,se=null,xe=null,ve=null,ds=!1,rr=!1,yr=0,i0=0,fs,p0,m0,h0,ks,g0,x0,Ue=!1,cu,Cc,mu,Sc,bc,Fo=!1,Te=!1,I0,R=null,Od=!1,be=null,pa=!1,S0,cs,ri,ta,q=0,Ie=null,ge=null,Pe=0,je=0,on,we=0,kr=null,Tt=0,Ss=0,oi=0,sr=null,Oe=null,si=0,Ln=1/0,Ba=null,ps=!1,Lu=null,rt=null,Do=!1,Ya=null,ms=0,lr=0,yu=null,Vo=-1,Go=0,Nc,Wc,qn,O0,Xt,ci=function(e,a){if(!Vc(e))throw Error(S(299));var t=!1,n="",r=Wc;return a!==null&&a!==void 0&&(a.unstable_strictMode===!0&&(t=!0),a.identifierPrefix!==void 0&&(n=a.identifierPrefix),a.onRecoverableError!==void 0&&(r=a.onRecoverableError)),a=Uc(e,1,!1,null,null,t,!1,n,r),e[In]=a.current,Ou(e.nodeType===8?e.parentNode:e),new fi(a)},_s=function(e){return bs(e)},pi=function(e,a,t){if(!Vc(e))throw Error(S(405));var n=t!=null&&t.hydratedSources||null,r=!1,o="",s=Wc;if(t!==null&&t!==void 0&&(t.unstable_strictMode===!0&&(r=!0),t.identifierPrefix!==void 0&&(o=t.identifierPrefix),t.onRecoverableError!==void 0&&(s=t.onRecoverableError)),a=E0(a,null,e,1,t!=null?t:null,r,!1,o,s),e[In]=a.current,Ou(e),n)for(e=0;e<n.length;e++)t=n[e],r=t._getVersion,r=r(t._source),a.mutableSourceEagerHydrationData==null?a.mutableSourceEagerHydrationData=[t,r]:a.mutableSourceEagerHydrationData.push(t,r);return new Ms(a)};var Gc=Xs(()=>{ia();re=Ai(Vi());Kd=new Set,ur={};Ha=!(typeof window>"u"||typeof window.document>"u"||typeof window.document.createElement>"u"),_l=Object.prototype.hasOwnProperty,Nm=/^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$/,Gi={},ji={};Me={};"children dangerouslySetInnerHTML defaultValue defaultChecked innerHTML suppressContentEditableWarning suppressHydrationWarning style".split(" ").forEach(function(e){Me[e]=new Ne(e,0,!1,e,null,!1,!1)});[["acceptCharset","accept-charset"],["className","class"],["htmlFor","for"],["httpEquiv","http-equiv"]].forEach(function(e){var a=e[0];Me[a]=new Ne(a,1,!1,e[1],null,!1,!1)});["contentEditable","draggable","spellCheck","value"].forEach(function(e){Me[e]=new Ne(e,2,!1,e.toLowerCase(),null,!1,!1)});["autoReverse","externalResourcesRequired","focusable","preserveAlpha"].forEach(function(e){Me[e]=new Ne(e,2,!1,e,null,!1,!1)});"allowFullScreen async autoFocus autoPlay controls default defer disabled disablePictureInPicture disableRemotePlayback formNoValidate hidden loop noModule noValidate open playsInline readOnly required reversed scoped seamless itemScope".split(" ").forEach(function(e){Me[e]=new Ne(e,3,!1,e.toLowerCase(),null,!1,!1)});["checked","multiple","muted","selected"].forEach(function(e){Me[e]=new Ne(e,3,!0,e,null,!1,!1)});["capture","download"].forEach(function(e){Me[e]=new Ne(e,4,!1,e,null,!1,!1)});["cols","rows","size","span"].forEach(function(e){Me[e]=new Ne(e,6,!1,e,null,!1,!1)});["rowSpan","start"].forEach(function(e){Me[e]=new Ne(e,5,!1,e.toLowerCase(),null,!1,!1)});ku=/[\-:]([a-z])/g;"accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y word-spacing writing-mode xmlns:xlink x-height".split(" ").forEach(function(e){var a=e.replace(ku,Cu);Me[a]=new Ne(a,1,!1,e,null,!1,!1)});"xlink:actuate xlink:arcrole xlink:role xlink:show xlink:title xlink:type".split(" ").forEach(function(e){var a=e.replace(ku,Cu);Me[a]=new Ne(a,1,!1,e,"http://www.w3.org/1999/xlink",!1,!1)});["xml:base","xml:lang","xml:space"].forEach(function(e){var a=e.replace(ku,Cu);Me[a]=new Ne(a,1,!1,e,"http://www.w3.org/XML/1998/namespace",!1,!1)});["tabIndex","crossOrigin"].forEach(function(e){Me[e]=new Ne(e,1,!1,e.toLowerCase(),null,!1,!1)});Me.xlinkHref=new Ne("xlinkHref",1,!1,"xlink:href","http://www.w3.org/1999/xlink",!0,!1);["src","href","action","formAction"].forEach(function(e){Me[e]=new Ne(e,1,!1,e.toLowerCase(),null,!0,!0)});Va=_n,vo=Symbol.for("react.element"),Wn=Symbol.for("react.portal"),Zt=Symbol.for("react.fragment"),bu=Symbol.for("react.strict_mode"),Al=Symbol.for("react.profiler"),Xd=Symbol.for("react.provider"),Zd=Symbol.for("react.context"),Pu=Symbol.for("react.forward_ref"),zl=Symbol.for("react.suspense"),Tl=Symbol.for("react.suspense_list"),Mu=Symbol.for("react.memo"),$a=Symbol.for("react.lazy"),Qd=Symbol.for("react.offscreen"),$i=Symbol.iterator;le=Object.assign;Gn=Array.isArray;nf=function(e){return typeof MSApp<"u"&&MSApp.execUnsafeLocalFunction?function(a,t,n,r){MSApp.execUnsafeLocalFunction(function(){return e(a,t,n,r)})}:e}(function(e,a){if(e.namespaceURI!=="http://www.w3.org/2000/svg"||"innerHTML"in e)e.innerHTML=a;else{ko=ko||document.createElement("div"),ko.innerHTML="<svg>"+a.valueOf().toString()+"</svg>";for(a=ko.firstChild;e.firstChild;)e.removeChild(e.firstChild);for(;a.firstChild;)e.appendChild(a.firstChild)}});Jn={animationIterationCount:!0,aspectRatio:!0,borderImageOutset:!0,borderImageSlice:!0,borderImageWidth:!0,boxFlex:!0,boxFlexGroup:!0,boxOrdinalGroup:!0,columnCount:!0,columns:!0,flex:!0,flexGrow:!0,flexPositive:!0,flexShrink:!0,flexNegative:!0,flexOrder:!0,gridArea:!0,gridRow:!0,gridRowEnd:!0,gridRowSpan:!0,gridRowStart:!0,gridColumn:!0,gridColumnEnd:!0,gridColumnSpan:!0,gridColumnStart:!0,fontWeight:!0,lineClamp:!0,lineHeight:!0,opacity:!0,order:!0,orphans:!0,tabSize:!0,widows:!0,zIndex:!0,zoom:!0,fillOpacity:!0,floodOpacity:!0,stopOpacity:!0,strokeDasharray:!0,strokeDashoffset:!0,strokeMiterlimit:!0,strokeOpacity:!0,strokeWidth:!0},Gm=["Webkit","ms","Moz","O"];Object.keys(Jn).forEach(function(e){Gm.forEach(function(a){a=a+e.charAt(0).toUpperCase()+e.substring(1),Jn[a]=Jn[e]})});jm=le({menuitem:!0},{area:!0,base:!0,br:!0,col:!0,embed:!0,hr:!0,img:!0,input:!0,keygen:!0,link:!0,meta:!0,param:!0,source:!0,track:!0,wbr:!0});if(Ha)try{vt={},Object.defineProperty(vt,"passive",{get:function(){Wl=!0}}),window.addEventListener("test",vt,vt),window.removeEventListener("test",vt,vt)}catch(e){Wl=!1}Zm={onError:function(e){er=!0,Ko=e}};cf=re.unstable_scheduleCallback,ed=re.unstable_cancelCallback,ah=re.unstable_shouldYield,th=re.unstable_requestPaint,me=re.unstable_now,nh=re.unstable_getCurrentPriorityLevel,Au=re.unstable_ImmediatePriority,pf=re.unstable_UserBlockingPriority,Zo=re.unstable_NormalPriority,rh=re.unstable_LowPriority,mf=re.unstable_IdlePriority;ha=Math.clz32?Math.clz32:uh,sh=Math.log,lh=Math.LN2;bo=[],fr=new Map,cr=new Map,Xa=[],ch="mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset submit".split(" ");dn=Va.ReactCurrentBatchConfig;yn={eventPhase:0,bubbles:0,cancelable:0,timeStamp:function(e){return e.timeStamp||Date.now()},defaultPrevented:0,isTrusted:0},Du=Xe(yn),Sr=le({},yn,{view:0,detail:0}),xh=Xe(Sr),xs=le({},Sr,{screenX:0,screenY:0,clientX:0,clientY:0,pageX:0,pageY:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,getModifierState:Bu,button:0,buttons:0,relatedTarget:function(e){return e.relatedTarget===void 0?e.fromElement===e.srcElement?e.toElement:e.fromElement:e.relatedTarget},movementX:function(e){if("movementX"in e)return e.movementX;return e!==On&&(On&&e.type==="mousemove"?(pl=e.screenX-On.screenX,ml=e.screenY-On.screenY):ml=pl=0,On=e),pl},movementY:function(e){return"movementY"in e?e.movementY:ml}}),rd=Xe(xs),wh=le({},xs,{dataTransfer:0}),Lh=Xe(wh),yh=le({},Sr,{relatedTarget:0}),hl=Xe(yh),vh=le({},yn,{animationName:0,elapsedTime:0,pseudoElement:0}),Ih=Xe(vh),kh=le({},yn,{clipboardData:function(e){return"clipboardData"in e?e.clipboardData:window.clipboardData}}),Ch=Xe(kh),Sh=le({},yn,{data:0}),od=Xe(Sh),bh={Esc:"Escape",Spacebar:" ",Left:"ArrowLeft",Up:"ArrowUp",Right:"ArrowRight",Down:"ArrowDown",Del:"Delete",Win:"OS",Menu:"ContextMenu",Apps:"ContextMenu",Scroll:"ScrollLock",MozPrintableKey:"Unidentified"},Ph={8:"Backspace",9:"Tab",12:"Clear",13:"Enter",16:"Shift",17:"Control",18:"Alt",19:"Pause",20:"CapsLock",27:"Escape",32:" ",33:"PageUp",34:"PageDown",35:"End",36:"Home",37:"ArrowLeft",38:"ArrowUp",39:"ArrowRight",40:"ArrowDown",45:"Insert",46:"Delete",112:"F1",113:"F2",114:"F3",115:"F4",116:"F5",117:"F6",118:"F7",119:"F8",120:"F9",121:"F10",122:"F11",123:"F12",144:"NumLock",145:"ScrollLock",224:"Meta"},Mh={Alt:"altKey",Control:"ctrlKey",Meta:"metaKey",Shift:"shiftKey"};Ah=le({},Sr,{key:function(e){if(e.key){var a=bh[e.key]||e.key;if(a!=="Unidentified")return a}return e.type==="keypress"?(e=No(e),e===13?"Enter":String.fromCharCode(e)):e.type==="keydown"||e.type==="keyup"?Ph[e.keyCode]||"Unidentified":""},code:0,location:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,repeat:0,locale:0,getModifierState:Bu,charCode:function(e){return e.type==="keypress"?No(e):0},keyCode:function(e){return e.type==="keydown"||e.type==="keyup"?e.keyCode:0},which:function(e){return e.type==="keypress"?No(e):e.type==="keydown"||e.type==="keyup"?e.keyCode:0}}),zh=Xe(Ah),Th=le({},xs,{pointerId:0,width:0,height:0,pressure:0,tangentialPressure:0,tiltX:0,tiltY:0,twist:0,pointerType:0,isPrimary:0}),sd=Xe(Th),Rh=le({},Sr,{touches:0,targetTouches:0,changedTouches:0,altKey:0,metaKey:0,ctrlKey:0,shiftKey:0,getModifierState:Bu}),Fh=Xe(Rh),Dh=le({},yn,{propertyName:0,elapsedTime:0,pseudoElement:0}),Bh=Xe(Dh),Eh=le({},xs,{deltaX:function(e){return"deltaX"in e?e.deltaX:("wheelDeltaX"in e)?-e.wheelDeltaX:0},deltaY:function(e){return"deltaY"in e?e.deltaY:("wheelDeltaY"in e)?-e.wheelDeltaY:("wheelDelta"in e)?-e.wheelDelta:0},deltaZ:0,deltaMode:0}),Nh=Xe(Eh),Oh=[9,13,27,32],Eu=Ha&&"CompositionEvent"in window;Ha&&"documentMode"in document&&(ar=document.documentMode);Uh=Ha&&"TextEvent"in window&&!ar,Cf=Ha&&(!Eu||ar&&8<ar&&11>=ar),ld=String.fromCharCode(32);Wh={color:!0,date:!0,datetime:!0,"datetime-local":!0,email:!0,month:!0,number:!0,password:!0,range:!0,search:!0,tel:!0,text:!0,time:!0,url:!0,week:!0};if(Ha){if(Ha){if(Kn="oninput"in document,!Kn)Oo=document.createElement("div"),Oo.setAttribute("oninput","return;"),Kn=typeof Oo.oninput==="function";$n=Kn}else $n=!1;Mf=$n&&(!document.documentMode||9<document.documentMode)}xa=typeof Object.is==="function"?Object.is:Zh;Yh=Ha&&"documentMode"in document&&11>=document.documentMode;Jt={animationend:Mo("Animation","AnimationEnd"),animationiteration:Mo("Animation","AnimationIteration"),animationstart:Mo("Animation","AnimationStart"),transitionend:Mo("Transition","TransitionEnd")},gl={},Tf={};Ha&&(Tf=document.createElement("div").style,("AnimationEvent"in window)||(delete Jt.animationend.animation,delete Jt.animationiteration.animation,delete Jt.animationstart.animation),("TransitionEvent"in window)||delete Jt.transitionend.transition);Rf=Ls("animationend"),Ff=Ls("animationiteration"),Df=Ls("animationstart"),Bf=Ls("transitionend"),Ef=new Map,md="abort auxClick cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");for(Xn=0;Xn<md.length;Xn++)Zn=md[Xn],Zl=Zn.toLowerCase(),Ql=Zn[0].toUpperCase()+Zn.slice(1),it(Zl,"on"+Ql);it(Rf,"onAnimationEnd");it(Ff,"onAnimationIteration");it(Df,"onAnimationStart");it("dblclick","onDoubleClick");it("focusin","onFocus");it("focusout","onBlur");it(Bf,"onTransitionEnd");pn("onMouseEnter",["mouseout","mouseover"]);pn("onMouseLeave",["mouseout","mouseover"]);pn("onPointerEnter",["pointerout","pointerover"]);pn("onPointerLeave",["pointerout","pointerover"]);Rt("onChange","change click focusin focusout input keydown keyup selectionchange".split(" "));Rt("onSelect","focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" "));Rt("onBeforeInput",["compositionend","keypress","textInput","paste"]);Rt("onCompositionEnd","compositionend focusout keydown keypress keyup mousedown".split(" "));Rt("onCompositionStart","compositionstart focusout keydown keypress keyup mousedown".split(" "));Rt("onCompositionUpdate","compositionupdate focusout keydown keypress keyup mousedown".split(" "));Qn="abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" "),Jh=new Set("cancel close invalid load scroll toggle".split(" ").concat(Qn));_o="_reactListening"+Math.random().toString(36).slice(2);e0=/\r\n?/g,a0=/\u0000|\uFFFD/g;au=typeof setTimeout==="function"?setTimeout:void 0,t0=typeof clearTimeout==="function"?clearTimeout:void 0,wd=typeof Promise==="function"?Promise:void 0,n0=typeof queueMicrotask==="function"?queueMicrotask:typeof wd<"u"?function(e){return wd.resolve(null).then(e).catch(r0)}:au;vn=Math.random().toString(36).slice(2),Ma="__reactFiber$"+vn,xr="__reactProps$"+vn,In="__reactContainer$"+vn,tu="__reactEvents$"+vn,o0="__reactListeners$"+vn,s0="__reactHandles$"+vn;nu=[];ut={},Re=dt(ut),He=dt(!1),_t=ut;an=[],Je=[];u0=Va.ReactCurrentBatchConfig;gn=Gf(!0),jf=Gf(!1),ss=dt(null);br={},Aa=dt(br),wr=dt(br),Lr=dt(br);oe=dt(0);vl=[];Ho=Va.ReactCurrentDispatcher,Il=Va.ReactCurrentBatchConfig;fs={readContext:na,useCallback:Ae,useContext:Ae,useEffect:Ae,useImperativeHandle:Ae,useInsertionEffect:Ae,useLayoutEffect:Ae,useMemo:Ae,useReducer:Ae,useRef:Ae,useState:Ae,useDebugValue:Ae,useDeferredValue:Ae,useTransition:Ae,useMutableSource:Ae,useSyncExternalStore:Ae,useId:Ae,unstable_isNewReconciler:!1},p0={readContext:na,useCallback:function(e,a){return Pa().memoizedState=[e,a===void 0?null:a],e},useContext:na,useEffect:Md,useImperativeHandle:function(e,a,t){return t=t!==null&&t!==void 0?t.concat([e]):null,qo(4194308,4,sc.bind(null,a,e),t)},useLayoutEffect:function(e,a){return qo(4194308,4,e,a)},useInsertionEffect:function(e,a){return qo(4,2,e,a)},useMemo:function(e,a){var t=Pa();return a=a===void 0?null:a,e=e(),t.memoizedState=[e,a],e},useReducer:function(e,a,t){var n=Pa();return a=t!==void 0?t(a):a,n.memoizedState=n.baseState=a,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:e,lastRenderedState:a},n.queue=e,e=e.dispatch=f0.bind(null,se,e),[n.memoizedState,e]},useRef:function(e){var a=Pa();return e={current:e},a.memoizedState=e},useState:Pd,useDebugValue:ti,useDeferredValue:function(e){return Pa().memoizedState=e},useTransition:function(){var e=Pd(!1),a=e[0];return e=d0.bind(null,e[1]),Pa().memoizedState=e,[a,e]},useMutableSource:function(){},useSyncExternalStore:function(e,a,t){var n=se,r=Pa();if(ne){if(t===void 0)throw Error(S(407));t=t()}else{if(t=a(),Ie===null)throw Error(S(349));(zt&30)!==0||Yf(n,a,t)}r.memoizedState=t;var o={value:t,getSnapshot:a};return r.queue=o,Md(ec.bind(null,n,o,e),[e]),n.flags|=2048,Ir(9,Jf.bind(null,n,o,t,a),void 0,null),t},useId:function(){var e=Pa(),a=Ie.identifierPrefix;if(ne){var t=Oa,n=Na;t=(n&~(1<<32-ha(n)-1)).toString(32)+t,a=":"+a+"R"+t,t=yr++,0<t&&(a+="H"+t.toString(32)),a+=":"}else t=i0++,a=":"+a+"r"+t.toString(32)+":";return e.memoizedState=a},unstable_isNewReconciler:!1},m0={readContext:na,useCallback:uc,useContext:na,useEffect:ai,useImperativeHandle:lc,useInsertionEffect:rc,useLayoutEffect:oc,useMemo:ic,useReducer:kl,useRef:nc,useState:function(){return kl(vr)},useDebugValue:ti,useDeferredValue:function(e){var a=ra();return dc(a,xe.memoizedState,e)},useTransition:function(){var e=kl(vr)[0],a=ra().memoizedState;return[e,a]},useMutableSource:Zf,useSyncExternalStore:Qf,useId:fc,unstable_isNewReconciler:!1},h0={readContext:na,useCallback:uc,useContext:na,useEffect:ai,useImperativeHandle:lc,useInsertionEffect:rc,useLayoutEffect:oc,useMemo:ic,useReducer:Cl,useRef:nc,useState:function(){return Cl(vr)},useDebugValue:ti,useDeferredValue:function(e){var a=ra();return xe===null?a.memoizedState=e:dc(a,xe.memoizedState,e)},useTransition:function(){var e=Cl(vr)[0],a=ra().memoizedState;return[e,a]},useMutableSource:Zf,useSyncExternalStore:Qf,useId:fc,unstable_isNewReconciler:!1};ks={isMounted:function(e){return(e=e._reactInternals)?Ft(e)===e:!1},enqueueSetState:function(e,a,t){e=e._reactInternals;var n=Ee(),r=ot(e),o=Ua(n,r);o.payload=a,t!==void 0&&t!==null&&(o.callback=t),a=nt(e,o,r),a!==null&&(ga(a,e,r,n),Uo(a,e,r))},enqueueReplaceState:function(e,a,t){e=e._reactInternals;var n=Ee(),r=ot(e),o=Ua(n,r);o.tag=1,o.payload=a,t!==void 0&&t!==null&&(o.callback=t),a=nt(e,o,r),a!==null&&(ga(a,e,r,n),Uo(a,e,r))},enqueueForceUpdate:function(e,a){e=e._reactInternals;var t=Ee(),n=ot(e),r=Ua(t,n);r.tag=2,a!==void 0&&a!==null&&(r.callback=a),a=nt(e,r,n),a!==null&&(ga(a,e,n,t),Uo(a,e,n))}};g0=typeof WeakMap==="function"?WeakMap:Map;x0=Va.ReactCurrentOwner;cu={dehydrated:null,treeContext:null,retryLane:0};Cc=function(e,a){for(var t=a.child;t!==null;){if(t.tag===5||t.tag===6)e.appendChild(t.stateNode);else if(t.tag!==4&&t.child!==null){t.child.return=t,t=t.child;continue}if(t===a)break;for(;t.sibling===null;){if(t.return===null||t.return===a)return;t=t.return}t.sibling.return=t.return,t=t.sibling}};mu=function(){};Sc=function(e,a,t,n){var r=e.memoizedProps;if(r!==n){e=a.stateNode,bt(Aa.current);var o=null;switch(t){case"input":r=Fl(e,r),n=Fl(e,n),o=[];break;case"select":r=le({},r,{value:void 0}),n=le({},n,{value:void 0}),o=[];break;case"textarea":r=El(e,r),n=El(e,n),o=[];break;default:typeof r.onClick!=="function"&&typeof n.onClick==="function"&&(e.onclick=as)}Ol(t,n);var s;t=null;for(c in r)if(!n.hasOwnProperty(c)&&r.hasOwnProperty(c)&&r[c]!=null)if(c==="style"){var l=r[c];for(s in l)l.hasOwnProperty(s)&&(t||(t={}),t[s]="")}else c!=="dangerouslySetInnerHTML"&&c!=="children"&&c!=="suppressContentEditableWarning"&&c!=="suppressHydrationWarning"&&c!=="autoFocus"&&(ur.hasOwnProperty(c)?o||(o=[]):(o=o||[]).push(c,null));for(c in n){var u=n[c];if(l=r!=null?r[c]:void 0,n.hasOwnProperty(c)&&u!==l&&(u!=null||l!=null))if(c==="style")if(l){for(s in l)!l.hasOwnProperty(s)||u&&u.hasOwnProperty(s)||(t||(t={}),t[s]="");for(s in u)u.hasOwnProperty(s)&&l[s]!==u[s]&&(t||(t={}),t[s]=u[s])}else t||(o||(o=[]),o.push(c,t)),t=u;else c==="dangerouslySetInnerHTML"?(u=u?u.__html:void 0,l=l?l.__html:void 0,u!=null&&l!==u&&(o=o||[]).push(c,u)):c==="children"?typeof u!=="string"&&typeof u!=="number"||(o=o||[]).push(c,""+u):c!=="suppressContentEditableWarning"&&c!=="suppressHydrationWarning"&&(ur.hasOwnProperty(c)?(u!=null&&c==="onScroll"&&ae("scroll",e),o||l===u||(o=[])):(o=o||[]).push(c,u))}t&&(o=o||[]).push("style",t);var c=o;if(a.updateQueue=c)a.flags|=4}};bc=function(e,a,t,n){t!==n&&(a.flags|=4)};I0=typeof WeakSet==="function"?WeakSet:Set;S0=Math.ceil,cs=Va.ReactCurrentDispatcher,ri=Va.ReactCurrentOwner,ta=Va.ReactCurrentBatchConfig,on=dt(0);Nc=function(e,a,t){if(e!==null)if(e.memoizedProps!==a.pendingProps||He.current)Ue=!0;else{if((e.lanes&t)===0&&(a.flags&128)===0)return Ue=!1,L0(e,a,t);Ue=(e.flags&131072)!==0?!0:!1}else Ue=!1,ne&&(a.flags&1048576)!==0&&qf(a,os,a.index);switch(a.lanes=0,a.tag){case 2:var n=a.type;Wo(e,a),e=a.pendingProps;var r=mn(a,Re.current);fn(a,t),r=Ju(null,a,n,e,r,t);var o=ei();return a.flags|=1,typeof r==="object"&&r!==null&&typeof r.render==="function"&&r.$$typeof===void 0?(a.tag=1,a.memoizedState=null,a.updateQueue=null,qe(n)?(o=!0,ns(a)):o=!1,a.memoizedState=r.state!==null&&r.state!==void 0?r.state:null,Ku(a),r.updater=ks,a.stateNode=r,r._reactInternals=a,uu(a,n,e,t),a=fu(null,a,n,!0,o,t)):(a.tag=0,ne&&o&&Hu(a),Be(null,a,r,t),a=a.child),a;case 16:n=a.elementType;e:{switch(Wo(e,a),e=a.pendingProps,r=n._init,n=r(n._payload),a.type=n,r=a.tag=D0(n),e=ca(n,e),r){case 0:a=du(null,a,n,e,t);break e;case 1:a=Bd(null,a,n,e,t);break e;case 11:a=Fd(null,a,n,e,t);break e;case 14:a=Dd(null,a,n,ca(n.type,e),t);break e}throw Error(S(306,n,""))}return a;case 0:return n=a.type,r=a.pendingProps,r=a.elementType===n?r:ca(n,r),du(e,a,n,r,t);case 1:return n=a.type,r=a.pendingProps,r=a.elementType===n?r:ca(n,r),Bd(e,a,n,r,t);case 3:e:{if(vc(a),e===null)throw Error(S(387));n=a.pendingProps,o=a.memoizedState,r=o.element,Kf(e,a),us(a,n,null,t);var s=a.memoizedState;if(n=s.element,o.isDehydrated)if(o={element:n,isDehydrated:!1,cache:s.cache,pendingSuspenseBoundaries:s.pendingSuspenseBoundaries,transitions:s.transitions},a.updateQueue.baseState=o,a.memoizedState=o,a.flags&256){r=wn(Error(S(423)),a),a=Ed(e,a,n,t,r);break e}else if(n!==r){r=wn(Error(S(424)),a),a=Ed(e,a,n,t,r);break e}else for($e=tt(a.stateNode.containerInfo.firstChild),Ke=a,ne=!0,ma=null,t=jf(a,null,n,t),a.child=t;t;)t.flags=t.flags&-3|4096,t=t.sibling;else{if(hn(),n===r){a=Wa(e,a,t);break e}Be(e,a,n,t)}a=a.child}return a;case 5:return Xf(a),e===null&&ou(a),n=a.type,r=a.pendingProps,o=e!==null?e.memoizedProps:null,s=r.children,eu(n,r)?s=null:o!==null&&eu(n,o)&&(a.flags|=32),yc(e,a),Be(e,a,s,t),a.child;case 6:return e===null&&ou(a),null;case 13:return Ic(e,a,t);case 4:return Xu(a,a.stateNode.containerInfo),n=a.pendingProps,e===null?a.child=gn(a,null,n,t):Be(e,a,n,t),a.child;case 11:return n=a.type,r=a.pendingProps,r=a.elementType===n?r:ca(n,r),Fd(e,a,n,r,t);case 7:return Be(e,a,a.pendingProps,t),a.child;case 8:return Be(e,a,a.pendingProps.children,t),a.child;case 12:return Be(e,a,a.pendingProps.children,t),a.child;case 10:e:{if(n=a.type._context,r=a.pendingProps,o=a.memoizedProps,s=r.value,Y(ss,n._currentValue),n._currentValue=s,o!==null)if(xa(o.value,s)){if(o.children===r.children&&!He.current){a=Wa(e,a,t);break e}}else for(o=a.child,o!==null&&(o.return=a);o!==null;){var l=o.dependencies;if(l!==null){s=o.child;for(var u=l.firstContext;u!==null;){if(u.context===n){if(o.tag===1){u=Ua(-1,t&-t),u.tag=2;var c=o.updateQueue;if(c!==null){c=c.shared;var m=c.pending;m===null?u.next=u:(u.next=m.next,m.next=u),c.pending=u}}o.lanes|=t,u=o.alternate,u!==null&&(u.lanes|=t),su(o.return,t,a),l.lanes|=t;break}u=u.next}}else if(o.tag===10)s=o.type===a.type?null:o.child;else if(o.tag===18){if(s=o.return,s===null)throw Error(S(341));s.lanes|=t,l=s.alternate,l!==null&&(l.lanes|=t),su(s,t,a),s=o.sibling}else s=o.child;if(s!==null)s.return=o;else for(s=o;s!==null;){if(s===a){s=null;break}if(o=s.sibling,o!==null){o.return=s.return,s=o;break}s=s.return}o=s}Be(e,a,r.children,t),a=a.child}return a;case 9:return r=a.type,n=a.pendingProps.children,fn(a,t),r=na(r),n=n(r),a.flags|=1,Be(e,a,n,t),a.child;case 14:return n=a.type,r=ca(n,a.pendingProps),r=ca(n.type,r),Dd(e,a,n,r,t);case 15:return wc(e,a,a.type,a.pendingProps,t);case 17:return n=a.type,r=a.pendingProps,r=a.elementType===n?r:ca(n,r),Wo(e,a),a.tag=1,qe(n)?(e=!0,ns(a)):e=!1,fn(a,t),hc(a,n,r),uu(a,n,r,t),fu(null,a,n,!0,e,t);case 19:return kc(e,a,t);case 22:return Lc(e,a,t)}throw Error(S(156,a.tag))};Wc=typeof reportError==="function"?reportError:function(e){console.error(e)};Ms.prototype.render=fi.prototype.render=function(e){var a=this._internalRoot;if(a===null)throw Error(S(409));qc(e,a,null,null)};Ms.prototype.unmount=fi.prototype.unmount=function(){var e=this._internalRoot;if(e!==null){this._internalRoot=null;var a=e.containerInfo;bs(function(){qc(null,e,null,null)}),a[In]=null}};Ms.prototype.unstable_scheduleHydration=function(e){if(e){var a=Lf();e={blockedOn:null,target:e,priority:a};for(var t=0;t<Xa.length&&a!==0&&a<Xa[t].priority;t++);Xa.splice(t,0,e),t===0&&vf(e)}};xf=function(e){switch(e.tag){case 3:var a=e.stateNode;if(a.current.memoizedState.isDehydrated){var t=jn(a.pendingLanes);t!==0&&(zu(a,t|1),We(a,me()),(q&6)===0&&(Ln=me()+500,ft()))}break;case 13:bs(function(){var n=qa(e,1);if(n!==null){var r=Ee();ga(n,e,1,r)}}),di(e,1)}};Tu=function(e){if(e.tag===13){var a=qa(e,134217728);if(a!==null){var t=Ee();ga(a,e,134217728,t)}di(e,134217728)}};wf=function(e){if(e.tag===13){var a=ot(e),t=qa(e,a);if(t!==null){var n=Ee();ga(t,e,a,n)}di(e,a)}};Lf=function(){return K};yf=function(e,a){var t=K;try{return K=e,a()}finally{K=t}};ql=function(e,a,t){switch(a){case"input":if(Dl(e,t),a=t.name,t.type==="radio"&&a!=null){for(t=e;t.parentNode;)t=t.parentNode;t=t.querySelectorAll("input[name="+JSON.stringify(""+a)+'][type="radio"]');for(a=0;a<t.length;a++){var n=t[a];if(n!==e&&n.form===e.form){var r=Uu(n);if(!r)throw Error(S(90));Jd(n),Dl(n,r)}}}break;case"textarea":af(e,t);break;case"select":a=t.value,a!=null&&sn(e,!!t.multiple,a,!1)}};sf=P0;lf=bs;qn={findFiberByHostInstance:Ct,bundleType:0,version:"18.3.1",rendererPackageName:"react-dom"},O0={bundleType:qn.bundleType,version:qn.version,rendererPackageName:qn.rendererPackageName,rendererConfig:qn.rendererConfig,overrideHookState:null,overrideHookStateDeletePath:null,overrideHookStateRenamePath:null,overrideProps:null,overridePropsDeletePath:null,overridePropsRenamePath:null,setErrorHandler:null,setSuspenseHandler:null,scheduleUpdate:null,currentDispatcherRef:Va.ReactCurrentDispatcher,findHostInstanceByFiber:function(e){return e=eh(e),e===null?null:e.stateNode},findFiberByHostInstance:qn.findFiberByHostInstance||N0,findHostInstancesForRefresh:null,scheduleRefresh:null,scheduleRoot:null,setRefreshHandler:null,getCurrentFiber:null,reconcilerVersion:"18.3.1-next-f1338f8080-20240426"};if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__<"u"){if(Xt=__REACT_DEVTOOLS_GLOBAL_HOOK__,!Xt.isDisabled&&Xt.supportsFiber)try{gs=Xt.inject(O0),_a=Xt}catch(e){}}});function jc(){if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__>"u"||typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE!=="function")return;try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(jc)}catch(e){console.error(e)}}var mi=Xs(()=>{Gc();jc()});var $c=zi(function(q0){mi();q0.createRoot=ci,q0.hydrateRoot=pi;var H0});var Kp=Ai($c(),1);var Kc=document.createElement("style");Kc.textContent=`/* The dotz look: the site's own tokens (style.css :root, light and dark)
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

/* The reply draft card, as the web app draws it (web/js/10-reply-card.js): a layer on the white card, the draft text on white */
.dz-draft {
  display: grid;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 14px;
  background: var(--surface-2);
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
  background: var(--surface);
  color: var(--body);
  font-size: 13px;
  line-height: 1.55;
}
.dz-draft__to { display: flex; gap: 10px; font-size: 12.5px; color: var(--muted); }
.dz-draft__to b { color: var(--ink); font-weight: 500; }
.dz-draft .dz-btn:not(.dz-btn--send):not(.dz-btn--text) { background: var(--surface); }

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
`;document.head.appendChild(Kc);ia();var Xc=(e)=>e.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase(),As=(...e)=>e.filter((a,t,n)=>Boolean(a)&&a.trim()!==""&&n.indexOf(a)===t).join(" ").trim();ia();var Zc={xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};var Qc=zn(({color:e="currentColor",size:a=24,strokeWidth:t=2,absoluteStrokeWidth:n,className:r="",children:o,iconNode:s,...l},u)=>Gt("svg",{ref:u,...Zc,width:a,height:a,stroke:e,strokeWidth:n?Number(t)*24/Number(a):t,className:As("lucide",r),...l},[...s.map(([c,m])=>Gt(c,m)),...Array.isArray(o)?o:[o]]));var A=(e,a)=>{let t=zn(({className:n,...r},o)=>Gt(Qc,{ref:o,iconNode:a,className:As(`lucide-${Xc(e)}`,n),...r}));return t.displayName=`${e}`,t};var ct=A("Ellipsis",[["circle",{cx:"12",cy:"12",r:"1",key:"41hilf"}],["circle",{cx:"19",cy:"12",r:"1",key:"1wjl8i"}],["circle",{cx:"5",cy:"12",r:"1",key:"1pcz8c"}]]);var za=A("House",[["path",{d:"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8",key:"5wwlr5"}],["path",{d:"M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",key:"1d0kgt"}]]);var Pr=A("Archive",[["rect",{width:"20",height:"5",x:"2",y:"3",rx:"1",key:"1wp1u1"}],["path",{d:"M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8",key:"1s80jp"}],["path",{d:"M10 12h4",key:"a56b0p"}]]);var Mr=A("ArrowRight",[["path",{d:"M5 12h14",key:"1ays0h"}],["path",{d:"m12 5 7 7-7 7",key:"xquz4c"}]]);var _r=A("ArrowUpRight",[["path",{d:"M7 7h10v10",key:"1tivn9"}],["path",{d:"M7 17 17 7",key:"1vkiza"}]]);var Ar=A("ArrowUp",[["path",{d:"m5 12 7-7 7 7",key:"hav0vg"}],["path",{d:"M12 19V5",key:"x0mq9r"}]]);var Dt=A("Bell",[["path",{d:"M10.268 21a2 2 0 0 0 3.464 0",key:"vwvbt9"}],["path",{d:"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",key:"11g9vi"}]]);var zr=A("Calendar",[["path",{d:"M8 2v4",key:"1cmpym"}],["path",{d:"M16 2v4",key:"4m81vk"}],["rect",{width:"18",height:"18",x:"3",y:"4",rx:"2",key:"1hopcy"}],["path",{d:"M3 10h18",key:"8toen8"}]]);var Tr=A("Check",[["path",{d:"M20 6 9 17l-5-5",key:"1gmf2c"}]]);var Bt=A("ChevronDown",[["path",{d:"m6 9 6 6 6-6",key:"qrunsl"}]]);var Rr=A("ChevronRight",[["path",{d:"m9 18 6-6-6-6",key:"mthhwq"}]]);var Fr=A("Clock",[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["polyline",{points:"12 6 12 12 16 14",key:"68esgv"}]]);var Dr=A("CreditCard",[["rect",{width:"20",height:"14",x:"2",y:"5",rx:"2",key:"ynyp8z"}],["line",{x1:"2",x2:"22",y1:"10",y2:"10",key:"1b3vmo"}]]);var Br=A("Eye",[["path",{d:"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",key:"1nclc0"}],["circle",{cx:"12",cy:"12",r:"3",key:"1v7zrd"}]]);var Er=A("File",[["path",{d:"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",key:"1rqfz7"}],["path",{d:"M14 2v4a2 2 0 0 0 2 2h4",key:"tnqrlb"}]]);var Nr=A("Folder",[["path",{d:"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",key:"1kt360"}]]);var Or=A("Globe",[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["path",{d:"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",key:"13o1zl"}],["path",{d:"M2 12h20",key:"9i4pu4"}]]);var Ur=A("GripVertical",[["circle",{cx:"9",cy:"12",r:"1",key:"1vctgf"}],["circle",{cx:"9",cy:"5",r:"1",key:"hp0tcf"}],["circle",{cx:"9",cy:"19",r:"1",key:"fkjjf6"}],["circle",{cx:"15",cy:"12",r:"1",key:"1tmaij"}],["circle",{cx:"15",cy:"5",r:"1",key:"19l28e"}],["circle",{cx:"15",cy:"19",r:"1",key:"f4zoj3"}]]);var Hr=A("Heart",[["path",{d:"M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",key:"c3ymky"}]]);var qr=A("Lock",[["rect",{width:"18",height:"11",x:"3",y:"11",rx:"2",ry:"2",key:"1w4ew1"}],["path",{d:"M7 11V7a5 5 0 0 1 10 0v4",key:"fwvmzm"}]]);var Wr=A("Mail",[["rect",{width:"20",height:"16",x:"2",y:"4",rx:"2",key:"18n3k1"}],["path",{d:"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7",key:"1ocrg3"}]]);var Vr=A("MessageCircle",[["path",{d:"M7.9 20A9 9 0 1 0 4 16.1L2 22Z",key:"vv11sd"}]]);var kn=A("Monitor",[["rect",{width:"20",height:"14",x:"2",y:"3",rx:"2",key:"48i651"}],["line",{x1:"8",x2:"16",y1:"21",y2:"21",key:"1svkeh"}],["line",{x1:"12",x2:"12",y1:"17",y2:"21",key:"vw1qmm"}]]);var Gr=A("Pause",[["rect",{x:"14",y:"4",width:"4",height:"16",rx:"1",key:"zuxfzm"}],["rect",{x:"6",y:"4",width:"4",height:"16",rx:"1",key:"1okwgv"}]]);var jr=A("Play",[["polygon",{points:"6 3 20 12 6 21 6 3",key:"1oa8hb"}]]);var $r=A("Plus",[["path",{d:"M5 12h14",key:"1ays0h"}],["path",{d:"M12 5v14",key:"s699le"}]]);var Kr=A("ScanFace",[["path",{d:"M3 7V5a2 2 0 0 1 2-2h2",key:"aa7l1z"}],["path",{d:"M17 3h2a2 2 0 0 1 2 2v2",key:"4qcy5o"}],["path",{d:"M21 17v2a2 2 0 0 1-2 2h-2",key:"6vwrx8"}],["path",{d:"M7 21H5a2 2 0 0 1-2-2v-2",key:"ioqczr"}],["path",{d:"M8 14s1.5 2 4 2 4-2 4-2",key:"1y1vjs"}],["path",{d:"M9 9h.01",key:"1q5me6"}],["path",{d:"M15 9h.01",key:"x1ddxp"}]]);var Et=A("Search",[["circle",{cx:"11",cy:"11",r:"8",key:"4ej97u"}],["path",{d:"m21 21-4.3-4.3",key:"1qie3q"}]]);var Xr=A("Send",[["path",{d:"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",key:"1ffxy3"}],["path",{d:"m21.854 2.147-10.94 10.939",key:"12cjpa"}]]);var Zr=A("Settings",[["path",{d:"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",key:"1qme2f"}],["circle",{cx:"12",cy:"12",r:"3",key:"1v7zrd"}]]);var Qr=A("SlidersHorizontal",[["line",{x1:"21",x2:"14",y1:"4",y2:"4",key:"obuewd"}],["line",{x1:"10",x2:"3",y1:"4",y2:"4",key:"1q6298"}],["line",{x1:"21",x2:"12",y1:"12",y2:"12",key:"1iu8h1"}],["line",{x1:"8",x2:"3",y1:"12",y2:"12",key:"ntss68"}],["line",{x1:"21",x2:"16",y1:"20",y2:"20",key:"14d8ph"}],["line",{x1:"12",x2:"3",y1:"20",y2:"20",key:"m0wm8r"}],["line",{x1:"14",x2:"14",y1:"2",y2:"6",key:"14e1ph"}],["line",{x1:"8",x2:"8",y1:"10",y2:"14",key:"1i6ji0"}],["line",{x1:"16",x2:"16",y1:"18",y2:"22",key:"1lctlv"}]]);var Yr=A("Star",[["path",{d:"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",key:"r04s7s"}]]);var Jr=A("Trash2",[["path",{d:"M3 6h18",key:"d0wm0j"}],["path",{d:"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6",key:"4alrt4"}],["path",{d:"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2",key:"v07s0e"}],["line",{x1:"10",x2:"10",y1:"11",y2:"17",key:"1uufr5"}],["line",{x1:"14",x2:"14",y1:"11",y2:"17",key:"xtxkd"}]]);var eo=A("User",[["path",{d:"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2",key:"975kel"}],["circle",{cx:"12",cy:"7",r:"4",key:"17ys0d"}]]);var ao=A("Wifi",[["path",{d:"M12 20h.01",key:"zekei9"}],["path",{d:"M2 8.82a15 15 0 0 1 20 0",key:"dnpr2z"}],["path",{d:"M5 12.859a10 10 0 0 1 14 0",key:"1x1e6c"}],["path",{d:"M8.5 16.429a5 5 0 0 1 7 0",key:"1bycff"}]]);var to=A("X",[["path",{d:"M18 6 6 18",key:"1bl5f8"}],["path",{d:"m6 6 12 12",key:"d8bk6v"}]]);var no=A("Zap",[["path",{d:"M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z",key:"1xq2db"}]]);ia();var Yc=document.createElement("style");Yc.textContent=`/* Stageshow kit: the stage. Tokens, the looks (theme, palette,
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
`;document.head.appendChild(Yc);mi();var Jc=document.createElement("style");Jc.textContent=`/* Keystrokes (act.key): the keycap rows. */

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
`;document.head.appendChild(Jc);ia();var W0=Symbol.for("react.element"),V0=Symbol.for("react.fragment"),G0=Object.prototype.hasOwnProperty,j0=_n.ReactCurrentOwner,$0={key:!0,ref:!0,__self:!0,__source:!0};function ep(e,a,t){var n,r={},o=null,s=null;t!==void 0&&(o=""+t),a.key!==void 0&&(o=""+a.key),a.ref!==void 0&&(s=a.ref);for(n in a)G0.call(a,n)&&!$0.hasOwnProperty(n)&&(r[n]=a[n]);if(e&&e.defaultProps)for(n in a=e.defaultProps,a)r[n]===void 0&&(r[n]=a[n]);return{$$typeof:W0,type:e,key:o,ref:s,props:r,_owner:j0.current}}var Ta=V0,i=ep,v=ep;var K0={cmd:"⌘",shift:"⇧",alt:"⌥",option:"⌥",ctrl:"⌃",enter:"↵",return:"↵",esc:"esc",tab:"⇥",up:"↑",down:"↓",left:"←",right:"→",backspace:"⌫"},ap=(e)=>e.split("+").map((a)=>K0[a.trim().toLowerCase()]??a.trim().toUpperCase());function tp({rows:e,at:a}){return i(Ta,{children:e.map((t)=>t&&i("div",{className:"ss-keys","data-show":t.show,"data-at":a,"aria-hidden":!0,children:t.caps.map((n,r)=>i("kbd",{className:"ss-key","data-down":t.down,children:n},r))},t.id))})}var zs={x:0,y:0,width:0,height:0},Ts=(e)=>typeof e==="string"?e:("at"in e)?e.at:null;var np=(e,a)=>e?.offsetWidth&&e.getBoundingClientRect().width/e.offsetWidth||a||1;function Rs(e,a){let t=e.getBoundingClientRect();return{left:t.left,top:t.top,scale:e.offsetWidth&&t.width/e.offsetWidth||a||1,borderX:e.clientLeft,borderY:e.clientTop}}function Nt(e,a,t,n=Rs(e,t)){let r=a.getBoundingClientRect(),{scale:o}=n;return{x:(r.left-n.left)/o-n.borderX,y:(r.top-n.top)/o-n.borderY,width:r.width/o,height:r.height/o}}function rp(e,a,t,n=Rs(e,t)){let r=Nt(e,a,t,n),o=getComputedStyle(a),s=o.transform,l=s&&s!=="none"?s.match(/^matrix\(([^)]+)\)$/):null;if(!l)return r;let[u,c,m,g,h,w]=l[1].split(",").map(Number);if(c||m||h||w||!u||!g)return r;let x=r.width/u,k=r.height/g,[B,f]=o.transformOrigin.split(" ").map(parseFloat);return{x:r.x-B*(1-u),y:r.y-f*(1-g),width:x,height:k}}var X0=(e)=>{let a=getComputedStyle(e);return a.transform!=="none"||a.translate&&a.translate!=="none"||a.scale&&a.scale!=="none"||a.rotate&&a.rotate!=="none"};function op(e,a){let t=!0;for(let s=a;s&&s!==e;s=s.parentElement)if(X0(s)){t=!1;break}if(t)return Nt(e,a,1);let n=0,r=0,o=a;while(o&&o!==e){n+=o.offsetLeft,r+=o.offsetTop;let s=o.offsetParent;if(!s||!e.contains(s))break;if(o=s,o!==e)n+=o.clientLeft-o.scrollLeft,r+=o.clientTop-o.scrollTop}return{x:n,y:r,width:a.offsetWidth,height:a.offsetHeight}}function hi(e,a){let t=Object.keys(e);if(t.length!==Object.keys(a).length)return!1;return t.every((n)=>{let r=e[n],o=a[n];return o&&Math.abs(r.x-o.x)<0.5&&Math.abs(r.y-o.y)<0.5&&Math.abs(r.width-o.width)<0.5&&Math.abs(r.height-o.height)<0.5})}function Fs(e){let a=e.parentElement;if(!a?.classList.contains("ss-scroller"))return;let{clientHeight:t,scrollHeight:n}=e,r=n>t?Math.max(24,t/n*t):0,o=n>t?e.scrollTop/(n-t)*(t-r):0;a.style.setProperty("--ss-thumb-h",`${r}px`),a.style.setProperty("--ss-thumb-y",`${o}px`)}var Z0={house:[0.65,0,0.1,1],through:[0.8,0,0.1,1],settle:[0.05,0.85,0.3,1],enter:[0.1,0.8,0.3,0.95],trip:[0.78,0,0.17,1],camera:[0.45,0,0.1,1]};function sp(e){let[a,t,n,r]=typeof e==="string"?Z0[e]:e,o=3*a,s=3*(n-a)-o,l=1-o-s,u=3*t,c=3*(r-t)-u,m=1-u-c,g=(w)=>((l*w+s)*w+o)*w,h=(w)=>(3*l*w+2*s)*w+o;return(w)=>{if(w<=0)return 0;if(w>=1)return 1;let x=w;for(let k=0;k<8;k++){let B=h(x);if(Math.abs(B)<0.000001)break;let f=x-(g(x)-w)/B;if(f<0||f>1)break;x=f}if(Math.abs(g(x)-w)>0.000001){let k=0,B=1;for(let f=0;f<40;f++)if(x=(k+B)/2,g(x)<w)k=x;else B=x}return((m*x+c)*x+u)*x}}function gi(){try{return!1}catch{return!0}}function pt(e){if(gi())console.warn(`[stageshow] ${e}`)}var mt=(e,a,t)=>Math.min(t,Math.max(a,e)),Cn=(e)=>e<0.5?4*e*e*e:1-Math.pow(-2*e+2,3)/2,lp=(e)=>{let a=Math.sin(e*12.9898)*43758.5453;return a-Math.floor(a)};var up=(e)=>{if(!e)return;window.setTimeout(()=>e.removeAttribute("data-touching"),240)};class ht extends Error{}function ip(e,a){let{rootRef:t,cursorRef:n,pos:r,hovered:o,kindRef:s,keysRef:l,dragging:u,autoUsed:c,autoRef:m,scaleRef:g,speed:h,layout:w,cursor:x,resolve:k,place:B,remeasure:f,ripple:d,setState:p,setKind:L,setKeys:I,setLastKeys:T}=a,F=sp("enter"),y=()=>{if(e.aborted)throw new ht},Q=(M,b)=>new Promise((C,P)=>{y();let _=()=>{b(O),e.removeEventListener("abort",_),P(new ht)},O=M(()=>{if(e.removeEventListener("abort",_),e.aborted)P(new ht);else C()});e.addEventListener("abort",_,{once:!0})}),D=()=>Q((M)=>requestAnimationFrame(M),cancelAnimationFrame),V=(M)=>Q((b)=>setTimeout(b,M/h),clearTimeout),oa=(M)=>{let b=!0,C=()=>{if(!b)return;b=!1,e.removeEventListener("abort",C),M()};return e.addEventListener("abort",C,{once:!0}),C},Fe=async(M,b)=>{let C=performance.now(),P=M/h;for(;;){y();let _=Math.min(1,(performance.now()-C)/P);if(b(_),_===1)return;await D()}},Le=(M)=>{let b=[];for(let C=M;C&&C!==t.current;C=C.parentElement)if(C.hasAttribute("data-target"))b.push(C);return b},La=(M)=>{let b=t.current;if(!b)return;let C=b.querySelectorAll("[data-cursor]");if(!C.length&&!c.current)return;if(C.length)c.current=!0;let P=b.getBoundingClientRect(),_=P.width/b.offsetWidth||1,O=b.dataset.cursorBase??"pointer",X=O;b.setAttribute("data-hit","");let ue=document.elementsFromPoint(P.left+M.x*_,P.top+M.y*_);b.removeAttribute("data-hit");let E=ue.find((N)=>{if(!b.contains(N)||N.closest(".ss-cursor, .ss-keys, .ss-ripple"))return!1;if(getComputedStyle(N).pointerEvents==="none"&&!N.closest('[data-cursor], [data-target], button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="tab"]'))return!1;let ie=1;for(let j=N;j&&j!==b.parentElement;j=j.parentElement){let fe=getComputedStyle(j);if(fe.visibility==="hidden")return!1;ie*=Number(fe.opacity)}return ie>0.15});if(E){let N=E.closest('[data-cursor], button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="tab"]');if(X=N&&b.contains(N)&&N.dataset.cursor?N.dataset.cursor:O,X!==s.current)L(X);return}if(C.forEach((N)=>{let ie=N.getBoundingClientRect(),j=(ie.left-P.left)/_,fe=(ie.top-P.top)/_;if(M.x>=j&&M.x<=j+ie.width/_&&M.y>=fe&&M.y<=fe+ie.height/_)X=N.dataset.cursor}),X!==s.current)L(X)};if(m.current=La,!u.current)La(r.current);let Ge=(M)=>{if(o.current===M)return;let b=Le(M);Le(o.current).forEach((C)=>b.includes(C)||C.removeAttribute("data-hover")),b.forEach((C)=>C.setAttribute("data-hover","")),o.current=M},ye=l.current.id,Ze=0,sa=(M)=>{let b=Ts(M);return b===null?null:t.current?.querySelector(`[data-target="${b}"]`)??null},ke={get signal(){return e},put(M){if(!e.aborted)p((b)=>({...b,...typeof M==="function"?M(b):M}))},async set(M){y(),ke.put(M),await D(),await D(),m.current?.(r.current),y()},wait:async(M)=>{y(),await V(M)},rect:(M,b)=>{let C=t.current,P=C?.querySelector(`[data-target="${M}"]`);if(!C||!P)return pt(`no element with data-target="${M}"`),zs;return b?.layout?op(C,P):Nt(C,P,g.current)},center:(M)=>k(M),caret(M,b){Ze++;let C=sa(M),P=t.current;if(!C||!P)return 0;let _=P.getBoundingClientRect(),O=_.width/P.offsetWidth||1,X=_.left+b.x*O,ue=_.top+b.y*O,E=[],N=document.createTreeWalker(C,NodeFilter.SHOW_TEXT),ie=document.createRange(),j=0,fe=(G)=>{for(let Se=G.parentElement;Se;Se=Se===C?null:Se.parentElement){let J=getComputedStyle(Se);if(J.opacity==="0"||J.visibility==="hidden"||J.display==="none")return!0}return!1};for(let G=N.nextNode();G;G=N.nextNode()){let Se=G.textContent??"";if(fe(G))continue;for(let J=0;J<Se.length;J++){ie.setStart(G,J),ie.setEnd(G,J+1);let he=ie.getBoundingClientRect();if(he.width||he.height)E.push({left:he.left,right:he.right,mid:(he.left+he.right)/2,top:he.top,bottom:he.bottom,at:j+J})}j+=Se.length}if(!E.length)return 0;if(ue<E[0].top)return 0;if(ue>E[E.length-1].bottom)return j;let De=E[0];for(let G of E)if(Math.abs((G.top+G.bottom)/2-ue)<Math.abs((De.top+De.bottom)/2-ue))De=G;let Ce=E.filter((G)=>Math.abs(G.top-De.top)<(De.bottom-De.top)/2),Ot=Ce.find((G)=>G.mid>X);return Ot?Ot.at:Ce[Ce.length-1].at+1},async move(M,b){y();let C={...r.current},P=k(M),_=Math.hypot(P.x-C.x,P.y-C.y);if(_<0.5)return Ge(sa(M));let O=Le(sa(M));Ge(Le(o.current).find((j)=>O.includes(j))??null);let X=b?.duration??mt(260+_*0.9,300,650),ue=Cn,E=Math.min(_*0.08,24),N=-(P.y-C.y)/_,ie=(P.x-C.x)/_;await Fe(X,(j)=>{let fe=ue(j),De=Math.sin(Math.PI*fe)*E,Ce=b?.path?b.path(fe,C,P):{x:C.x+(P.x-C.x)*fe+N*De,y:C.y+(P.y-C.y)*fe+ie*De};if(B(Ce),La(Ce),b?.onMove)_s(()=>b.onMove(Ce,C,j))}),y(),Ge(sa(M))},async click(M,b){if(y(),M!==void 0)await ke.move(M),await V(120);y();let C=M!==void 0?sa(M):o.current,P=n.current,_=x?.style==="touch",O=oa(()=>{if(P?.removeAttribute("data-pressed"),C?.removeAttribute("data-pressed"),_)up(P)});try{if(_)P?.setAttribute("data-touching",""),await V(140),y();for(let X=0;X<(b?.double?2:1);X++){if(X)await V(70);if(y(),P?.setAttribute("data-pressed","true"),x?.ripple)d(r.current);C?.setAttribute("data-pressed",b?.right?"right":""),await V(b?.double?80:100),y(),P?.removeAttribute("data-pressed"),C?.removeAttribute("data-pressed")}}finally{O()}},async scroll(M,b,C){y();let P=sa(M);if(!P)return;let _=P.scrollTop,O=typeof b==="number"?b:_;if(typeof b==="string"){let E=sa(b);if(E)O=_+(E.getBoundingClientRect().top-P.getBoundingClientRect().top)/np(t.current,g.current)-(C?.offset??0)}if(O=mt(O,0,P.scrollHeight-P.clientHeight),x){let E=Nt(t.current,P,g.current||1),N=r.current;if(!(N.x>=E.x+8&&N.x<=E.x+E.width-8&&N.y>=E.y+8&&N.y<=E.y+E.height-8))await this.move({x:E.x+E.width*0.6,y:E.y+E.height*0.55}),await this.wait(120)}let X=P.parentElement?.classList.contains("ss-scroller")?P.parentElement:null;X?.setAttribute("data-scrolling","");let ue=oa(()=>X?.removeAttribute("data-scrolling"));try{await Fe(C?.duration??mt(420+Math.abs(O-_)*1.2,500,1400),(E)=>{P.scrollTop=_+(O-_)*Cn(E),P.toggleAttribute("data-scrolled",P.scrollTop>0.5),Fs(P)}),y()}finally{ue()}f(),m.current?.(r.current)},async snap(M,b){y();let C=b?t.current?.querySelector(`[data-target="${b}"]`):t.current;C?.setAttribute("data-instant","");let P=oa(()=>C?.removeAttribute("data-instant"));try{ke.put(M),await D(),await D(),y()}finally{P()}},async key(M){y();let b=ap(M),C=++ye,P=l.current;T(P.caps.length?{...P,show:!1,down:!1}:null),I({id:C,caps:b,show:!1,down:!1}),await D(),await D(),y(),I({id:C,caps:b,show:!0,down:!1}),await V(180),y(),I({id:C,caps:b,show:!0,down:!0}),await V(140),y(),I({id:C,caps:b,show:!0,down:!1}),V(600).then(()=>{if(ye===C&&!e.aborted)I({id:C,caps:b,show:!1,down:!1})},(_)=>{if(!(_ instanceof ht))console.error("[stageshow] script error",_)})},async stagger(M,b,C=60){await Promise.all(M.map(async(P,_)=>{if(_)await V(C*_);y(),await b(P,_)}))},mark(M){if(!e.aborted)t.current?.setAttribute("data-mark",M)},async cursor(M){y(),L(M),await D()},async type(M,b,C){let P=C?.interval??35;for(let _=0;_<=b.length;_++)y(),p((O)=>({...O,[M]:b.slice(0,_)})),await V(P*(0.7+0.6*lp(_)))},place(M){if(e.aborted)return;let b=k(M);B(b),m.current?.(b)},async enter(M,b){y();let C=k(M),P=t.current,_={x:0,y:0,w:P.offsetWidth,h:P.offsetHeight},O=40,X=[C.x-_.x,_.x+_.w-C.x,C.y-_.y,_.y+_.h-C.y],ue=X.indexOf(Math.min(...X)),E=ue===0?{x:_.x-O,y:C.y+_.h*0.12}:ue===1?{x:_.x+_.w+O*0.4,y:C.y+_.h*0.12}:ue===2?{x:C.x-_.w*0.06,y:_.y-O}:{x:C.x+_.w*0.06,y:_.y+_.h+O*0.4};B(E),Ge(null),await Fe(b?.duration??700,(N)=>{let ie=F(N),j={x:E.x+(C.x-E.x)*ie,y:E.y+(C.y-E.y)*ie};B(j),La(j)}),y(),Ge(sa(M))},async drag(M,b,C){y();let P={...r.current},_=k(M),O=Math.hypot(_.x-P.x,_.y-P.y);Ge(null);let X=s.current,ue=X==="ibeam"||X==="crosshair",E=!ue&&C?.cursor!=="preserve",N=x?.style==="touch",ie=(G)=>G<0.25?G*G/0.5*1.1428571428571428:(G-0.125)*1.1428571428571428;if(N)n.current?.setAttribute("data-touching",""),await V(140),y();let j=N?n.current?.querySelector(".ss-cursor__streak")??null:null,fe=[],De=(G)=>{if(fe.unshift({...G}),fe.length>9)fe.pop();let Se=fe[fe.length-1],J=G.x-Se.x,he=G.y-Se.y,Ut=Math.min(Math.hypot(J,he),100);if(!j)return;j.style.width=`${Ut}px`,j.style.left=`${-Ut}px`,j.style.transform=`rotate(${Math.atan2(he,J)}rad)`};u.current=!0;let Ce=n.current,Ot=oa(()=>{if(u.current=!1,Ce?.removeAttribute("data-pressed"),Ce?.removeAttribute("data-swiping"),N)up(Ce)});try{if(Ce?.setAttribute("data-pressed","true"),await V(N?170:60),N){if(j)j.style.width="0px";Ce?.setAttribute("data-swiping","")}if(y(),E&&!N)L("grab");if(!N)await V(70);y(),Ce?.removeAttribute("data-pressed");let G=ue?0:Math.min(O*0.06,18),Se=O?-(_.y-P.y)/O:0,J=O?(_.x-P.x)/O:0,he=ue&&Math.abs(_.y-P.y)>6;if(he&&_.y>P.y&&_.x<P.x-2)pt("a text selection that ends left of where it starts overshoots and shrinks back; select text that starts a line, or fits on one");let Ut=Ze;if(await Fe(N?C?.duration??mt(180+O*0.5,240,300):C?.duration??mt(360+O*1.1,450,900),(Sn)=>{let ya=N?ie(Sn):Cn(Sn),Ht=Math.sin(Math.PI*ya)*G,uo=he?1-(1-ya)*(1-ya):ya,io=he?ya*ya:ya,qt=C?.path?.(ya,P,_)??{x:P.x+(_.x-P.x)*io+Se*Ht,y:P.y+(_.y-P.y)*uo+J*Ht};if(_s(()=>b?.(qt,P,Sn)),B(qt),N)De(qt)}),ue&&b&&Ze===Ut)pt("selection drift: a text selection drag never read a.caret(), so the highlight is not under the I-beam; set it from a.caret(name, at) in onMove");if(y(),E&&!N)L(X==="grab"?"pointer":X)}finally{Ot()}m.current?.(_)},layout:w};for(let M of Object.keys(ke)){let b=ke[M];if(typeof b!=="function")continue;ke[M]=(...C)=>{let P=b.apply(ke,C);if(P instanceof Promise)P.catch((_)=>{if(!(_ instanceof ht))console.error("[stageshow] script error",_)});return P}}return ke}function dp(e,a,t,n){let r=Object.keys(a).filter((o)=>JSON.stringify(e[o])!==JSON.stringify(a[o]));if(r.length)pt(`loop seam: state still differs from initial at the end of the script (${r.join(", ")})`);if(n&&Math.hypot(t.x-n.x,t.y-n.y)>1)pt("loop seam: cursor does not end where it starts")}function cp(){return i("svg",{height:"24",width:"24",viewBox:"0 0 32 32",fill:"none",children:v("g",{transform:"translate(10 7)",children:[i("path",{d:"m6.148 18.473 1.863-1.003 1.615-.839-2.568-4.816h4.332l-11.379-11.408v16.015l3.316-3.221z",fill:"#fff"}),i("path",{d:"m6.431 17 1.765-.941-2.775-5.202h3.604l-8.025-8.043v11.188l2.53-2.442z",fill:"#000"})]})})}function pp(){return v("svg",{width:"10",height:"16",viewBox:"0 0 10 16",fill:"none",overflow:"visible",children:[i("path",{d:"M3 1H7M3 15H7M5 1V15",style:{stroke:"var(--ss-cursor-edge, #fff)"},strokeWidth:"2.6",strokeLinecap:"round"}),i("path",{d:"M3 1H7M3 15H7M5 1V15",style:{stroke:"var(--ss-cursor-line, #000)"},strokeWidth:"1",strokeLinecap:"round"})]})}function mp(){return v("svg",{width:"17",height:"17",viewBox:"0 0 17 17",fill:"none",overflow:"visible",children:[i("path",{d:"M8.5 0V17M0 8.5H17",style:{stroke:"var(--ss-cursor-edge, #fff)"},strokeWidth:"2.6"}),i("path",{d:"M8.5 0V17M0 8.5H17",style:{stroke:"var(--ss-cursor-line, #000)"},strokeWidth:"1"})]})}function hp(){return v("svg",{width:"26",height:"26",viewBox:"0 0 32 32",fill:"none",children:[i("path",{d:"M10.6 6a1.7 1.7 0 0 1 3.4 0v6.6a1.3 1.3 0 0 1 2.6 0v.7a1.3 1.3 0 0 1 2.6 0v.7a1.3 1.3 0 0 1 2.6 0V19c0 3.1-2 5.6-5 5.6h-2.6c-2 0-3.3-.9-4.4-2.4l-3.1-4.1c-.6-.9-.4-2 .5-2.5.8-.4 1.7-.2 2.3.5l1.1 1.4V6Z",fill:"#fff",stroke:"#000",strokeWidth:"1.1",strokeLinejoin:"round"}),i("path",{d:"M14 12.6v3.6M16.6 13.3v3M19.2 14v2.6",stroke:"#000",strokeWidth:"1",strokeLinecap:"round"})]})}function gp(){return i("svg",{width:"26",height:"26",viewBox:"0 0 32 32",fill:"none",children:v("g",{transform:"translate(7 6)",children:[i("path",{d:"m4.5557 8.5742c-.098-.375-.196-.847-.406-1.552-.167-.557-.342-.859-.47-1.233-.155-.455-.303-.721-.496-1.181-.139-.329-.364-1.048-.457-1.44-.119-.509.033-.924.244-1.206.253-.339.962-.49 1.357-.351.371.13.744.512.916.788.288.46.357.632.717 1.542.393.992.564 1.918.611 2.231l.085.452c-.001-.04-.043-1.122-.044-1.162-.035-1.029-.06-1.823-.038-2.939.002-.126.064-.587.084-.715.078-.5.305-.8.673-.979.412-.201.926-.215 1.401-.017.423.173.626.55.687 1.022.014.109.094.987.093 1.107-.013 1.025.006 1.641.015 2.174.004.231.003 1.625.017 1.469.061-.656.094-3.189.344-3.942.144-.433.405-.746.794-.929.431-.203 1.113-.07 1.404.243.285.305.446.692.482 1.153.032.405-.019.897-.02 1.245 0 .867-.021 1.324-.037 2.121-.001.038-.015.298.023.182.094-.28.188-.542.266-.745.049-.125.241-.614.359-.859.114-.234.211-.369.415-.688.2-.313.415-.448.668-.561.54-.235 1.109.112 1.301.591.086.215.009.713-.028 1.105-.061.647-.254 1.306-.352 1.648-.128.447-.274 1.235-.34 1.601-.072.394-.234 1.382-.359 1.82-.086.301-.371.978-.652 1.384 0 0-1.074 1.25-1.192 1.812-.117.563-.078.567-.101.965-.024.399.121.923.121.923s-.802.104-1.234.034c-.391-.062-.875-.841-1-1.078-.172-.328-.539-.265-.682-.023-.225.383-.709 1.07-1.051 1.113-.668.084-2.054.03-3.139.02 0 0 .185-1.011-.227-1.358-.305-.26-.83-.784-1.144-1.06l-.832-.921c-.284-.36-.629-1.093-1.243-1.985-.348-.504-1.027-1.085-1.284-1.579-.223-.425-.331-.954-.19-1.325.225-.594.675-.897 1.362-.832.519.05.848.206 1.238.537.225.19.573.534.75.748.163.195.203.276.377.509.23.307.302.459.214.121",fill:"#fff"}),v("g",{stroke:"#000",strokeLinecap:"round",strokeWidth:".75",children:[i("path",{d:"m4.5557 8.5742c-.098-.375-.196-.847-.406-1.552-.167-.557-.342-.859-.47-1.233-.155-.455-.303-.721-.496-1.181-.139-.329-.364-1.048-.457-1.44-.119-.509.033-.924.244-1.206.253-.339.962-.49 1.357-.351.371.13.744.512.916.788.288.46.357.632.717 1.542.393.992.564 1.918.611 2.231l.085.452c-.001-.04-.043-1.122-.044-1.162-.035-1.029-.06-1.823-.038-2.939.002-.126.064-.587.084-.715.078-.5.305-.8.673-.979.412-.201.926-.215 1.401-.017.423.173.626.55.687 1.022.014.109.094.987.093 1.107-.013 1.025.006 1.641.015 2.174.004.231.003 1.625.017 1.469.061-.656.094-3.189.344-3.942.144-.433.405-.746.794-.929.431-.203 1.113-.07 1.404.243.285.305.446.692.482 1.153.032.405-.019.897-.02 1.245 0 .867-.021 1.324-.037 2.121-.001.038-.015.298.023.182.094-.28.188-.542.266-.745.049-.125.241-.614.359-.859.114-.234.211-.369.415-.688.2-.313.415-.448.668-.561.54-.235 1.109.112 1.301.591.086.215.009.713-.028 1.105-.061.647-.254 1.306-.352 1.648-.128.447-.274 1.235-.34 1.601-.072.394-.234 1.382-.359 1.82-.086.301-.371.978-.652 1.384 0 0-1.074 1.25-1.192 1.812-.117.563-.078.567-.101.965-.024.399.121.923.121.923s-.802.104-1.234.034c-.391-.062-.875-.841-1-1.078-.172-.328-.539-.265-.682-.023-.225.383-.709 1.07-1.051 1.113-.668.084-2.054.03-3.139.02 0 0 .185-1.011-.227-1.358-.305-.26-.83-.784-1.144-1.06l-.832-.921c-.284-.36-.629-1.093-1.243-1.985-.348-.504-1.027-1.085-1.284-1.579-.223-.425-.331-.954-.19-1.325.225-.594.675-.897 1.362-.832.519.05.848.206 1.238.537.225.19.573.534.75.748.163.195.203.276.377.509.23.307.302.459.214.121",strokeLinejoin:"round"}),i("path",{d:"m11.566 12.734v-3.459"}),i("path",{d:"m9.551 12.746-.016-3.473"}),i("path",{d:"m7.555 9.305.021 3.426"})]})]})})}function xp(){return i("svg",{width:"30",height:"30",viewBox:"0 0 32 32",fill:"none",children:v("g",{transform:"translate(8 9)",children:[i("path",{d:"m3.44281398 1.68449726c-.74326136.27630142-1.05584685.8131257-1.07636853 1.38003696-.01344897.37336893.06665513.72649286.23114214 1.18694303-.02596219-.07267623.09676488.29282004.12116236.37362273.05052942.16918921-.4865367-.05865774-.81377307.00741883-.36363321.07113868-.84783757.38332307-1.10006887.79754775-.29643467.48542737-.3109609 1.04368567-.08235979 2.04824266.12491868.54736183.36572145 1.00836814.71076689 1.44594879.15329951.1944118.5713628.64726015.60307236.6875974l.84854343.94062339c.15080214.1358526.25794954.2361946.57590427.5380259.3147558.2987762.4647038.4380078.60308951.555976.05846214.0492474.10784267.1797116.12740685.3736249.01609788.1595565.01049553.3375341-.0090192.5090254-.00674888.0593077-.01325791.1020883-.01698742.1224696-.04189161.228932.13269563.4403386.36541902.4424835.21585671.0019894.38528595.0046546.82216479.0123538.09483476.0016698.09483476.0016698.18993053.0033129 1.16876447.0200186 1.75308289.0147904 2.17807912-.0385723.45429894-.0572869.92650915-.6110188 1.32698393-1.2957591.34289141.6108338.81859723 1.2057867 1.2995685 1.2820532.1510118.0244148.3353555.0322555.548787.0275887.1606725-.0035131.3307029-.0140241.5021961-.0293376.1276907-.0114022.2293359-.0228648.29003-.0307451.2258836-.0293282.373669-.251611.3133108-.4712481-.0130351-.0474332-.0339838-.1345011-.0551094-.2441635-.0245945-.1276687-.0423383-.2523857-.0503381-.365988-.0050217-.0713101-.0059948-.1359317-.0027687-.1918983.0059157-.0980798.0077938-.1530073.0108033-.281125.0010795-.0448938.0010795-.0448938.0024606-.0845172.0054208-.1364475.0233824-.2649146.0815132-.544638.0250088-.1201275.1473169-.352189.3398902-.639435.0571394-.0852302.1195783-.1742239.1864664-.26609712.1272143-.17473362.2641361-.35131772.4011075-.52030772.082051-.10123129.145482-.17695689.1808122-.21807676.2967593-.42378347.612817-1.11823437.7291396-1.52536348.1117407-.39153936.202351-1.12501196.254373-1.81690429.029923-.39968605.0410555-.72381216.0410555-1.23011613.0000742-.09758414.0000742-.09758414.0002975-.17670236.0003569-.11115478.0003569-.11115478.000115-.20711835-.0008934-.15683883-.0055282-.31323355-.0207085-.69507578-.0313109-.81293139-.4771727-1.33911388-1.1344906-1.44058831-.559108-.08631314-1.0586051.08188477-1.2779293.31625977-.0755526.08073733.0036753-.2781823-.2159489-.62316278-.1644465-.25841586-.593184-.58905957-.9209287-.65355552-.335487-.06535532-.73539548-.05811715-1.1017193.00667481-.32093157.05742909-.68608434.33741751-.87176225.64688068-.12411885.20686477.03884667-.00592296-.09368743-.23401341-.18231052-.31422641-.60754287-.59486422-1.01411454-.67799709-.34643562-.07139428-.74182572-.04452925-1.09945614.0633873-.43336319.1291117-1.01795827.61460976-.94899189 1.15552627-.34375-.54091651-1.25026717-.691379-1.97906097-.42111797z",fill:"#000"}),i("path",{d:"m7.31951013 1.62138197c.20710357.04234751.44724204.20083012.51632974.31990811.08404358.1446387.15562749.36413806.21048667.6366124.02933373.14569467.12179446 1.2125285.29383112 1.32370243.41279229.04533731.41279229.04533731.52658055-.12364345.03545705-.07383858.03545705-.07383858.04226523-.1029106.01416796-.06009544.02463332-.12677987.0351322-.21754028l.00854738-.07915386.00047673-.00942804.00327525-.03167185c.01085148-.11424313.04184125-.4312127.05388392-.53034902.03788792-.31189663.08766449-.52757784.13944093-.6138719.0713024-.11883734.31942298-.28274442.43149612-.30279961.2804398-.04960082.58940103-.05519288.82623993-.00905543.1084394.02134018.3709471.22378689.432331.32024744.1291079.20279957.2524316.84889766.3225486 1.4970065-.0102194.04624251-.0102194.04624251.1640069.28984194.5843296-.06677889.5843296-.06677889.5703629-.17490247.0159511-.03856429.0284824-.08294031.045969-.15118961.0423876-.16089067.0697594-.25204451.111066-.35549917.0288558-.07227096.0592914-.13391873.0904889-.18278042.1209187-.19031132.4335712-.319392.7077174-.27707028.2943447.04543991.4816904.26653537.4994912.72869815.0148821.37434892.0193146.5239164.0201469.6700184l-.0004247.37954865c0 .48831141-.0104951.79388164-.0389535 1.17400348-.0480918.63962116-.1348512 1.34192123-.227649 1.66708484-.0946325.33121345-.3766371.95084197-.6003915 1.27298482-.0161892.01580846-.0841508.09694273-.1710333.20413492-.1445842.17838247-.2892181.36491271-.4247891.5511244-.0723398.09936149-.1402862.19620479-.2030964.2898938-.2440054.36396314-.400553.66098894-.4512157.90434304-.0659304.3172546-.0893838.4850003-.0966379.6675968-.0017072.0490782-.0017072.0490782-.002845.096677-.0028064.119476-.004437.1671639-.0097087.2545848-.0052654.091322-.0038193.187354.00332.2887353.0103318.1467182.1058713.3478531.1058713.3478531s-.2321503-.0119819-.3742084-.0088758c-.1718098.0037567-.3147843-.0023244-.4138162-.0183342-.1440353-.0228411-.53014068-.5057331-.7278511-.8821737-.30227042-.5764228-1.03604858-.5484427-1.33684295-.0394061-.26854779.4591613-.65918083.9172326-.7740684.9317199-.37404082.0469647-.94643778.0520862-2.07160079.0328144-.09480875-.0016381-.46003446-.0128683-.64600494-.0157445-.18597048-.0028763.05008807-.1790283.02786486-.399297-.03726222-.36933-.15125405-.6704984-.38877094-.8705429-.12241569-.1043631-.26774964-.2393104-.56509654-.5215613-.33323493-.3163366-.44236499-.4185353-.57290215-.533275l-.80130455-.89071892c-.03955779-.05174211-.45812831-.5051399-.5872217-.6688539-.28069963-.35597842-.47062947-.71959073-.56844755-1.14820437-.18921973-.83150113-.1793328-1.21146622-.00855589-1.49112273.13743587-.2257023.43815377-.4195862.60596039-.45241793.17165981-.03465512.55153059-.01648617.62179422.02229321.09902279.05401056.13357243.07300285.16379074.09097645.03572494.02124891.05965747.03799198.08182912.05708809.03426437.02951139.07235014.07170412.12420211.14044502.03611591.04821025.07806642.1053997.1423779.19304882.06054643.0816627.09183576.12069421.13369221.1590035.28038907.25662728.68391532.03238058.65052057-.32606956-.00567036-.06086415-.02203766-.12694598-.05458621-.23708502-.04356824-.15021272.00433013-.05284275-.26002629-.56642281-.08720664-.16942124-.13955864-.28835362-.17428227-.4046158l-.03412852-.10219113c-.03838756-.11059767-.09558223-.26854489-.12612861-.35199347l-.02009957-.05467087.002.008-.05974804-.17751191c-.09232236-.28807194-.13413567-.51358087-.12645475-.72681781.01040781-.28751553.16037753-.54506871.58790983-.70400047.40142488-.1488616 1.07786076.00117106 1.20581167.27856864.04319814.09369738.08927466.21199471.13900415.35457792l.03930997.11680217c.05539717.16759437.13470873.41493582.13860471.42816881.02724222.08344874.0471839.13860719.06943813.18441246.00217869.06301886.00217869.06301886.35429398.23177937.41699479-.29154152.41699479-.29154152.38019201-.37525838.00571063-.08773482.00758408-.17356287.00965287-.37317647.00242546-.23402898.00423842-.33154773.00994479-.45966208.01316411-.29554918.0437926-.51142116.09291227-.63864415.09160418-.23801371.25279279-.40993649.4432431-.46667832.24458613-.07380253.51465245-.09215236.73323569-.04710649zm1.21356228 4.27672201c-.20710459.00095412-.37422255.16961903-.37326843.37672361l.016 3.473c.00095412.20710459.16961903.37422251.37672361.37326841.20710459-.0009541.37422255-.16961901.37326843-.37672359l-.016-3.473c-.00095412-.20710459-.16961903-.37422255-.37672361-.37326843zm2.03332759.00229602c-.2071068 0-.375.16789322-.375.375v3.459c0 .20710678.1678932.375.375.375s.375-.16789322.375-.375v-3.459c0-.20710678-.1678932-.375-.375-.375zm-4.01399856.02930704c-.20710289.00126946-.37396385.17018863-.3726944.37729152l.021 3.426c.00126946.20710289.17018863.37396384.37729152.37269444.20710289-.0012695.37396385-.17018867.3726944-.37729156l-.021-3.426c-.00126946-.20710289-.17018863-.37396385-.37729152-.3726944z",fill:"#fff"})]})})}function wp(){return v("svg",{width:"16",height:"16",viewBox:"0 0 20 20",fill:"none",xmlns:"http://www.w3.org/2000/svg",children:[i("circle",{cx:"10",cy:"10",r:"8",stroke:"rgba(0,0,0,0.15)",strokeWidth:"2"}),i("path",{d:"M10 2A8 8 0 0 1 18 10",stroke:"black",strokeWidth:"2",strokeLinecap:"round"})]})}var fp="M0-8.4 2.55-3.65H-2.55ZM0 8.4 2.55 3.65H-2.55Z";function Ds({turn:e}){return i("svg",{width:"21",height:"21",viewBox:"-14 -14 28 28",overflow:"visible",children:v("g",{transform:`rotate(${e})`,strokeLinejoin:"round",children:[i("path",{d:fp,style:{fill:"var(--ss-cursor-edge, #fff)",stroke:"var(--ss-cursor-edge, #fff)"},strokeWidth:"3.2"}),i("path",{d:fp,style:{fill:"var(--ss-cursor-line, #000)",stroke:"var(--ss-cursor-line, #000)"},strokeWidth:"1.2"})]})})}var Lp=()=>i(Ds,{turn:0}),yp=()=>i(Ds,{turn:90}),vp=()=>i(Ds,{turn:-45}),Ip=()=>i(Ds,{turn:45});var kp=document.createElement("style");kp.textContent=`/* The cursor (cursor.tsx): glyphs, the five styles, press, idle, ripples. */

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
`;document.head.appendChild(kp);var Cp={pointer:cp,ibeam:pp,crosshair:mp,hand:hp,open:gp,grab:xp,wait:wp,"resize-ns":Lp,"resize-ew":yp,"resize-nwse":vp,"resize-nesw":Ip},Q0={pointer:{x:7.5,y:5.25},ibeam:{x:5,y:8},crosshair:{x:8.5,y:8.5},hand:{x:9.75,y:3.25},open:{x:11.7,y:10.4},grab:{x:12,y:12},wait:{x:8,y:8},"resize-ns":{x:10.5,y:10.5},"resize-ew":{x:10.5,y:10.5},"resize-nwse":{x:10.5,y:10.5},"resize-nesw":{x:10.5,y:10.5}},Y0={x:4,y:3};function J0(){return i("svg",{width:"22",height:"22",viewBox:"0 0 22 22",className:"ss-cursor__arrow","aria-hidden":!0,children:i("path",{d:"M4 3 18.5 9.6 11.8 11.8 9.6 18.5Z"})})}function Sp({cursorRef:e,style:a="real",kind:t}){return v("div",{ref:e,className:"ss-cursor","data-style":a,"data-kind":t,"aria-hidden":!0,children:[a==="touch"&&i("span",{className:"ss-cursor__streak"}),v("div",{className:"ss-cursor__press",children:[(a==="circle"||a==="touch")&&i("span",{className:"ss-cursor__dot"}),a!=="circle"&&a!=="touch"&&Object.keys(Cp).map((n)=>{let r=a==="arrow";if(r&&n!=="pointer"&&n!=="ibeam")return null;let o=r&&n==="pointer"?J0:Cp[n],s=r&&n==="pointer"?Y0:Q0[n];return i("div",{className:"ss-cursor__glyph","data-glyph":n,"data-active":n===(r&&t!=="ibeam"?"pointer":t),style:{marginLeft:-s.x,marginTop:-s.y,transformOrigin:`${s.x}px ${s.y}px`},children:i(o,{})},n)})]})]})}function bp(e,a){let t=document.createElement("span");t.className="ss-ripple",t.style.left=`${a.x}px`,t.style.top=`${a.y}px`,e.appendChild(t),t.addEventListener("animationend",()=>t.remove())}ia();var xi=An({theme:"light",palette:"accent",fidelity:"standard",layout:"wide"}),wi=()=>Tn(xi);ia();var Li=An(!1);function Pp(){let e=Tn(Li),[a,t]=pe(!1);return Ca(()=>{let n=window.matchMedia("(prefers-reduced-motion: reduce)"),r=()=>t(n.matches);return r(),n.addEventListener("change",r),()=>n.removeEventListener("change",r)},[]),e||a}var gt={now:()=>performance.now(),raf:(e)=>requestAnimationFrame(e),cancelRaf:(e)=>cancelAnimationFrame(e),layoutRaf:(e)=>gt.recording?.requestLayoutFrame(e)??requestAnimationFrame(e),cancelLayoutRaf:(e)=>{let a=gt.recording;if(a)a.cancelLayoutFrame(e);else cancelAnimationFrame(e)},timeout:(e,a)=>window.setTimeout(e,a),clearTimeout:(e)=>window.clearTimeout(e),get recording(){return typeof window>"u"?null:window.__stageshow?.clock??null}};var e1={};function Bs({width:e,height:a,initial:t=e1,script:n,poster:r,cursor:o,hover:s,play:l="loop",compact:u,keys:c="bottom",palette:m="accent",greys:g,fidelity:h="standard",specimen:w,unframed:x,speed:k=1,accent:B,tokens:f,ground:d,fill:p=!1,theme:L="light",className:I,children:T}){let F=l==="hover"&&typeof window<"u"&&window.matchMedia("(hover: none)").matches?"once":l,[y,Q]=pe("wide"),D=Z(y);D.current=y;let V=()=>{let z=o.at;return typeof z==="object"&&"wide"in z?z[D.current]:z},[oa,Fe]=pe(!1),Le=y==="compact"&&u?u.width:e,La=y==="compact"&&u?u.height:a,Ge=Z(null),ye=Z(null),Ze=Z(null),sa=Pp(),ke=!n||sa,[M,b]=pe(()=>ke&&r?r:t),C=Z(M);C.current=M;let[P,_]=pe(1),O=Z(1);O.current=P;let X=typeof window>"u"?{}:window.__stageshow??{},ue=k/(X.slow??1),E=X.theme??L,[N,ie]=pe(o?.kind??"pointer"),j=(z)=>{let U=ye.current;if(!U||sa)return;bp(U,z)},fe=Z(N);fe.current=N;let[De,Ce]=pe({id:0,caps:[],show:!1,down:!1}),[Ot,G]=pe(null),Se=Z(De);Se.current=De;let J=Z({x:0,y:0}),he=Z(null),[Ut,Sn]=pe(0),ya=Z(!1),Ht=Z(!1),uo=Z(null);ua(()=>{let z=Ge.current;if(!z)return;let U=()=>{let ee=z.clientWidth,va=!!z.parentElement?.closest("[data-ss-wide]"),Ia=u&&!va&&ee<u.below?"compact":"wide";Q(Ia);let Ra=p||!!z.parentElement?.closest("[data-ss-fill]");Fe(Ra);let ka=Ia==="compact"?u.width:e,la=Math.min(Ra?2:1,ee/ka);_(la),Sn(Math.max(0,(ee-ka*la)/2))};U();let W=new ResizeObserver(U);W.observe(z);let H=new MutationObserver(U);for(let ee=z.parentElement;ee;ee=ee.parentElement)H.observe(ee,{attributes:!0,attributeFilter:["data-ss-wide","data-ss-fill"]});return()=>{W.disconnect(),H.disconnect()}},[e,u?.below,u?.width,p]);let[io,qt]=pe({}),Us=Da(()=>{let z=ye.current;if(!z)return{};let U={},W=z.querySelectorAll("[data-target]");if(!W.length)return U;let H=Rs(z,O.current);return W.forEach((ee)=>{U[ee.dataset.target]=rp(z,ee,O.current,H)}),U},[]),Hs=Z({n:0,frame:0,owed:!1}),xt=Da(()=>{let z=Hs.current;if(!z.frame)z.frame=gt.layoutRaf(()=>{if(z.n=0,z.frame=0,!z.owed)return;z.owed=!1;let W=Us();qt((H)=>hi(H,W)?H:W)});if(z.n>=4){z.owed=!0;return}z.n++;let U=Us();qt((W)=>hi(W,U)?W:U)},[Us]);ua(xt),ua(()=>()=>{gt.cancelLayoutRaf(Hs.current.frame),Hs.current={n:0,frame:0,owed:!1}},[]),Ca(()=>{let z=ye.current;if(!z)return;return z.addEventListener("transitionend",xt),z.addEventListener("animationend",xt),()=>{z.removeEventListener("transitionend",xt),z.removeEventListener("animationend",xt)}},[xt]);let Zp=Da((z)=>io[z]??zs,[io]),[Qp,Ii]=pe(!0);ua(()=>{Ii(!0);let z=!0,U=0,W=()=>{U=gt.layoutRaf(()=>{U=gt.layoutRaf(()=>z&&Ii(!1))})};if(!document.fonts||document.fonts.status==="loaded")W();else document.fonts.ready.then(()=>z&&W());return()=>{z=!1,gt.cancelLayoutRaf(U)}},[y]);let Wt=Z(0),bn=Z(0),Pn=Z(!1),qs=Z(null),Vt=Da((z)=>{if(bn.current&&!Pn.current&&Math.hypot(z.x-J.current.x,z.y-J.current.y)>0.5)Pn.current=!0,qs.current??=performance.now()-bn.current;J.current=z,Wt.current=performance.now();let U=Ze.current;if(!U)return;U.style.transform=`translate(${z.x}px, ${z.y}px)`,U.removeAttribute("data-idle")},[]),wt=Da((z)=>{if(typeof z==="object"&&z!==null&&"wide"in z)z=D.current==="compact"?z.compact:z.wide;let U=Ts(z);if(U===null)return z;let W=ye.current,H=W?.querySelector(`[data-target="${U}"]`);if(!W||!H)return pt(`no element with data-target="${U}"`),J.current;let ee=Nt(W,H,O.current),va=typeof z==="string"?{x:0.5,y:0.5}:z;return{x:ee.x+ee.width*va.x,y:ee.y+ee.height*va.y}},[]);ua(()=>{if(!ke||!s)return;let z=ye.current;s.forEach((U)=>z?.querySelector(`[data-target="${U}"]`)?.setAttribute("data-hover",""))}),ua(()=>{if(o&&!bn.current)Vt(wt(V()))},[P,y]);let Ws=Z(0),Lt=Z(0),fo=Da(()=>{++Ws.current,cancelAnimationFrame(Lt.current),Lt.current=0,ye.current?.removeAttribute("data-settling")},[]),Vs=Da((z=!1)=>{fo();let U=Ws.current;if(Ht.current=!1,b(t),ie(o?.kind??"pointer"),Ce((H)=>({...H,show:!1,down:!1})),G(null),ye.current?.querySelectorAll("[data-hover],[data-pressed]").forEach((H)=>{H.removeAttribute("data-hover"),H.removeAttribute("data-pressed")}),ye.current?.removeAttribute("data-mark"),ye.current?.querySelectorAll("[data-scrolled]").forEach((H)=>{H.scrollTop=0,H.removeAttribute("data-scrolled"),Fs(H)}),ye.current?.querySelectorAll("[data-scrolling]").forEach((H)=>H.removeAttribute("data-scrolling")),Ze.current?.removeAttribute("data-pressed"),uo.current=null,!o)return;if(!z){Lt.current=requestAnimationFrame(()=>{Lt.current=0,Vt(wt(V())),he.current?.(J.current)});return}let W=ye.current;W?.setAttribute("data-settling",""),Lt.current=requestAnimationFrame(()=>{let H={...J.current},ee=wt(V()),va=mt(320+Math.hypot(ee.x-H.x,ee.y-H.y)*0.7,380,700),Ia=performance.now(),Ra=()=>{if(Ws.current!==U)return;let ka=Math.min(1,(performance.now()-Ia)/va),la=Cn(ka);if(Vt({x:H.x+(ee.x-H.x)*la,y:H.y+(ee.y-H.y)*la}),ka<1)Lt.current=requestAnimationFrame(Ra);else Lt.current=0,W?.removeAttribute("data-settling")};Ra()})},[y]),ki=po(()=>(z)=>ip(z,{rootRef:ye,cursorRef:Ze,pos:J,hovered:uo,kindRef:fe,keysRef:Se,dragging:Ht,autoUsed:ya,autoRef:he,scaleRef:O,speed:ue,layout:y,cursor:o,resolve:wt,place:Vt,remeasure:xt,ripple:j,setState:b,setKind:ie,setKeys:Ce,setLastKeys:G}),[wt,Vt,ue,y]);Ca(()=>{let z=ye.current;if(ke||!n)return Vs(),z.removeAttribute("data-offscreen"),b(r??t),fo;Vs();let U=Ge.current,W=null,H=!1,ee=!1,va=!1,Ia=o?.idle??4000,Ra=1200,ka=0,la=0,em=()=>{if(window.clearInterval(ka),!o||Ia===!1)return;Wt.current=performance.now(),ka=window.setInterval(()=>{let ce=Ze.current;if(!ce)return;let Qe=performance.now();if(!Pn.current){if(qs.current===null&&Qe-Wt.current>Ra)ce.setAttribute("data-idle","");return}if(ce.hasAttribute("data-pressed")||ye.current?.querySelector("[data-hover]"))Wt.current=Qe;else if(Qe-Wt.current>Ia)ce.setAttribute("data-idle","")},150)},am=()=>{bn.current=performance.now(),Pn.current=!1,window.clearTimeout(la);let ce=Ze.current,Qe=qs.current;if(Ia===!1||!ce||Qe===null||Qe<=Ra)return;ce.setAttribute("data-idle",""),la=window.setTimeout(()=>ce.removeAttribute("data-idle"),Qe-400)},Gs=()=>{window.clearInterval(ka),window.clearTimeout(la),bn.current=0,Ze.current?.removeAttribute("data-idle")},tm=()=>{window.clearInterval(ka),window.clearTimeout(la);let ce=Ze.current,Qe=()=>ce?.hasAttribute("data-pressed")||z.querySelector("[data-hover]");if(!o||Ia===!1||!ce||ce.hasAttribute("data-idle")||Qe())return;let co=(Pn.current?Ia:Ra)-(performance.now()-Wt.current);la=window.setTimeout(()=>{if(!Qe())ce.setAttribute("data-idle","")},Math.max(0,co))},js=()=>{if(W||va||!H||document.hidden)return;if(F==="hover"&&!ee)return;if(fo(),o)Vt(wt(V()));W=new AbortController;let ce=W.signal;em();let Qe=ki(ce);(async()=>{do{am();try{await n(Qe)}catch(co){if(co instanceof ht)return;console.error("[stageshow] script error",co),W=null,Gs();return}if(F==="loop"&&gi())dp(C.current,t,J.current,o?wt(V()):null)}while(F==="loop"&&!ce.aborted);if(F==="once"&&!ce.aborted)va=!0,tm()})()},$s=(ce=!1)=>{if(Gs(),!W)return;if(W.abort(),W=null,!va)Vs(ce)},Ks=()=>z.toggleAttribute("data-offscreen",!H||document.hidden);Ks();let Ci=new IntersectionObserver(([ce])=>{H=ce.isIntersecting,Ks(),H?js():$s()});Ci.observe(U);let Si=()=>{Ks(),document.hidden?$s():js()};document.addEventListener("visibilitychange",Si);let bi=()=>{ee=!0,js()},Pi=()=>{ee=!1,$s(!0)};if(F==="hover")U.addEventListener("pointerenter",bi),U.addEventListener("pointerleave",Pi);return()=>{Ci.disconnect(),document.removeEventListener("visibilitychange",Si),U.removeEventListener("pointerenter",bi),U.removeEventListener("pointerleave",Pi),Gs(),W?.abort(),W=null,he.current=null,fo()}},[ke,n,ki,F,y]),ua(()=>{if(o&&!ke&&!Ht.current)he.current?.(J.current)},[M]);let Yp=po(()=>({theme:E,palette:m,fidelity:h,layout:y}),[E,m,h,y]),Jp=o&&(!n||!ke||o.still);return i("div",{ref:Ge,className:`ss-fit${I?` ${I}`:""}`,style:{maxWidth:oa?void 0:e,height:La*P},children:v("div",{ref:ye,className:"ss-stage","data-specimen":w||void 0,"data-unframed":x||void 0,"data-still":ke||void 0,"data-placing":Qp||void 0,"data-theme":E,"data-palette":m,"data-greys":g==="cool"?"cool":void 0,"data-fidelity":h,"data-layout":y,style:{width:Le,height:La,marginLeft:Ut||void 0,transform:`scale(${P})`,...f,...B?{["--ss-accent"]:B,["--ss-accent-2"]:B,["--ss-accent-soft"]:`color-mix(in srgb, ${B} 14%, transparent)`}:null},children:[d&&i("div",{className:"ss-ground","aria-hidden":!0,style:Array.isArray(d)?{["--ss-orb-1"]:d[0],["--ss-orb-2"]:d[1],...d[2]?{["--ss-orb-3"]:d[2]}:null}:void 0}),i(Li.Provider,{value:ke,children:i(xi.Provider,{value:Yp,children:T(M,Zp,y)})}),n&&i(tp,{rows:[Ot,De],at:typeof c==="string"?c:c[y]}),Jp&&i(Sp,{cursorRef:Ze,style:o.style,kind:N})]})})}var Mp=document.createElement("style");Mp.textContent=`/* Window chrome (window.tsx): browser, app and sidebar app, plus the Bar and
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
`;document.head.appendChild(Mp);function ro(){return v("span",{className:"ss-window__lights",children:[i("span",{className:"ss-window__dot"}),i("span",{className:"ss-window__dot"}),i("span",{className:"ss-window__dot"})]})}function a1(){return v("svg",{className:"ss-window__lock",width:"7",height:"8",viewBox:"0 0 7 8","aria-hidden":!0,children:[i("path",{d:"M1.5 3.3V2.4a2 2 0 0 1 4 0v.9",fill:"none",stroke:"currentColor",strokeWidth:"1.1"}),i("rect",{x:"0",y:"3.3",width:"7",height:"4.7",rx:"1.2",fill:"currentColor"})]})}function _p({back:e}){return i("svg",{className:"ss-window__chev",width:"10",height:"10",viewBox:"0 0 10 10","aria-hidden":!0,children:i("path",{d:e?"M6.5 1.5 3 5l3.5 3.5":"M3.5 1.5 7 5 3.5 8.5",fill:"none",stroke:"currentColor",strokeWidth:"1.4",strokeLinecap:"round",strokeLinejoin:"round"})})}function Ap({url:e,urlShape:a,tabs:t,nav:n,title:r,sidebar:o,sidebarWidth:s=180,sidebarStyle:l,toolbar:u,lead:c,body:m,className:g,receded:h,chrome:w,lights:x,lightsSize:k,barSize:B,children:f,...d}){let p=`ss-window ss-recede${g?` ${g}`:""}`,L=k==="large"?"large":void 0,I=B==="tall"?"tall":void 0;if(w==="terminal")return v("div",{...d,className:p,"data-chrome":"terminal","data-lights":x==="grey"?"grey":void 0,"data-lights-size":L,"data-receded":h||void 0,children:[v("div",{className:"ss-window__bar",children:[i(ro,{}),r!==void 0&&i("span",{className:"ss-term__title",children:r})]}),i("div",{...m,className:`ss-window__body ss-term${m?.className?` ${m.className}`:""}`,children:f})]});if(w==="glass"||w==="card"||w==="hairline")return v("div",{...d,className:p,"data-chrome":w,"data-lights":x==="color"||x==="white"?x:w==="glass"?"grey":void 0,"data-receded":h||void 0,children:[v("div",{className:"ss-window__bar",children:[i(ro,{}),e!==void 0&&v("span",{className:"ss-window__url",children:[w==="glass"&&i(a1,{}),i("span",{className:"ss-window__url-text",children:e})]}),i("span",{className:"ss-window__end",children:u})]}),i("div",{...m,className:`ss-window__body${m?.className?` ${m.className}`:""}`,children:f})]});let T=e!==void 0&&v(Ta,{children:[n&&v("span",{className:"ss-window__nav",children:[i(_p,{back:!0}),i(_p,{})]}),i("span",{className:"ss-window__url",children:e})]});if(o!==void 0)return v("div",{...d,className:p,"data-kind":"sidebar","data-side":l==="floating"?"floating":void 0,"data-lights":x==="grey"?"grey":void 0,"data-lights-size":L,"data-bar":I,"data-receded":h||void 0,"data-url-shape":a,children:[v("aside",{className:"ss-window__side",style:{width:s},children:[i("div",{className:"ss-window__side-top",children:i(ro,{})}),o]}),v("div",{className:"ss-window__main",children:[v("div",{className:"ss-window__bar",children:[r!==void 0&&i("span",{className:"ss-window__heading",children:r}),c,T,i("span",{className:"ss-window__spacer"}),u]}),i("div",{...m,className:`ss-window__body${m?.className?` ${m.className}`:""}`,children:f})]})]});if(t?.length)return v("div",{...d,className:p,"data-kind":"tabs","data-lights":x==="grey"?"grey":void 0,"data-lights-size":L,"data-receded":h||void 0,"data-url-shape":a,children:[v("div",{className:"ss-window__tabs",children:[i(ro,{}),t.map((F,y)=>v("span",{className:"ss-window__tab","data-active":y===0||void 0,children:[i("span",{className:"ss-window__favicon"}),i("span",{className:"ss-window__tab-label",children:F})]},y))]}),v("div",{className:"ss-window__bar",children:[T,u]}),i("div",{...m,className:`ss-window__body${m?.className?` ${m.className}`:""}`,children:f})]});return v("div",{...d,className:p,"data-receded":h||void 0,"data-url-shape":a,"data-lights":x==="grey"?"grey":void 0,"data-lights-size":L,"data-bar":I,children:[v("div",{className:"ss-window__bar",children:[i(ro,{}),T,r!==void 0&&i("span",{className:"ss-window__title","data-toolbar":u?!0:void 0,children:r}),c,e===void 0&&r===void 0&&i("span",{className:"ss-window__spacer"}),u]}),i("div",{...m,className:`ss-window__body${m?.className?` ${m.className}`:""}`,children:f})]})}ia();var zp=document.createElement("style");zp.textContent=`/* Collapse */

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
`;document.head.appendChild(zp);function Ve({open:e,reveal:a="clip",from:t="above",solid:n=!1,children:r,className:o,...s}){let[l,u]=pe(!1),[c,m]=pe(!1),g=Z(null),h=Z(!0);return ua(()=>{let w=g.current?.scrollHeight??0;if(w)m(w>44);if(h.current)return void(h.current=!1);u(!0);let x=setTimeout(()=>u(!1),900);return()=>clearTimeout(x)},[e]),i("div",{...s,className:`ss-collapse${o?` ${o}`:""}`,"data-open":e||void 0,"data-reveal":a,"data-solid":n||void 0,"data-from":a==="drop"?t:void 0,"data-moving":l||void 0,"data-tall":c||void 0,onTransitionEnd:(w)=>{if(w.target===w.currentTarget&&w.propertyName==="grid-template-rows")u(!1);s.onTransitionEnd?.(w)},children:i("div",{ref:g,className:"ss-collapse__inner","data-crop":a==="clip"||void 0,children:r})})}var Tp=document.createElement("style");Tp.textContent=`/* Icon */

@layer stageshow {
  .ss-icon {
    display: block;
    flex-shrink: 0;
  }
}
`;document.head.appendChild(Tp);var Rp={check:Tr,plus:$r,close:to,"chevron-right":Rr,"chevron-down":Bt,search:Et,globe:Or,external:_r,clock:Fr,archive:Pr,trash:Jr,more:ct,arrow:Mr,file:Er,user:eo,bell:Dt,card:Dr,bolt:no,lock:qr,play:jr,pause:Gr,faceid:Kr,wifi:ao,heart:Hr,star:Yr,calendar:zr,mail:Wr,send:Xr,home:za,gear:Zr,grip:Ur},t1={chip:"M3.5 2.5h9a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4a1.5 1.5 0 0 1 1.5-1.5zM2 6h4M2 10h4M10 6h4M10 10h4M6 2.5v11M10 2.5v11M6 8h4",contactless:"M6.8 6.2a2.5 2.5 0 0 1 0 3.6M8.5 4.5a5 5 0 0 1 0 7M10.3 2.7a7.5 7.5 0 0 1 0 10.6"},n1={bolt:"M9.6 1.2 3.2 8.9a.6.6 0 0 0 .5 1H7.4l-1 4.9a.4.4 0 0 0 .7.3l6.4-7.7a.6.6 0 0 0-.5-1H9.3l1-4.9a.4.4 0 0 0-.7-.3Z",card:"M3 3h10a1.75 1.75 0 0 1 1.75 1.75V5.6H1.25v-.85A1.75 1.75 0 0 1 3 3Zm-1.75 4.4h13.5v3.85A1.75 1.75 0 0 1 13 13H3a1.75 1.75 0 0 1-1.75-1.75Zm2.25 2.6v1h3v-1Z",bell:"M8 1.25a4.25 4.25 0 0 0-4.25 4.25v3.1l-1.3 2.1a.6.6 0 0 0 .5.9h10.1a.6.6 0 0 0 .5-.9l-1.3-2.1V5.5A4.25 4.25 0 0 0 8 1.25ZM6.2 13.1a1.9 1.9 0 0 0 3.6 0Z",user:"M8 1.5a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2Zm0 7.4c3.1 0 5.4 1.8 5.9 4.6a.7.7 0 0 1-.7.8H2.8a.7.7 0 0 1-.7-.8C2.6 10.7 4.9 8.9 8 8.9Z",clock:"M8 1.25a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5Zm-.75 3v4.2l2.9 1.75.75-1.25-2.15-1.3V4.25Z",check:"M8 1.25a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5Zm3 4.3-.95-.8-3.3 3.95-1.85-1.8-.85.9 2.8 2.75Z",lock:"M8 1.25A3.25 3.25 0 0 0 4.75 4.5v2H4.5A1.5 1.5 0 0 0 3 8v5.25a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V8a1.5 1.5 0 0 0-1.5-1.5h-.25v-2A3.25 3.25 0 0 0 8 1.25Zm-1.75 5.25v-2a1.75 1.75 0 0 1 3.5 0v2Z",play:"M4.5 2.6v10.8a.8.8 0 0 0 1.2.7l8.6-5.4a.8.8 0 0 0 0-1.4L5.7 1.9a.8.8 0 0 0-1.2.7Z",pause:"M4 2.5h2.6a.6.6 0 0 1 .6.6v9.8a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V3.1a.6.6 0 0 1 .6-.6Zm5.4 0H12a.6.6 0 0 1 .6.6v9.8a.6.6 0 0 1-.6.6H9.4a.6.6 0 0 1-.6-.6V3.1a.6.6 0 0 1 .6-.6Z",heart:"M8 14.2c-.2 0-6.6-3.7-6.6-8.4a3.6 3.6 0 0 1 6.6-2 3.6 3.6 0 0 1 6.6 2c0 4.7-6.4 8.4-6.6 8.4Z",star:"M8 1.2a.6.6 0 0 1 .55.35l1.75 3.6 3.95.55a.6.6 0 0 1 .33 1.03l-2.86 2.8.68 3.94a.6.6 0 0 1-.87.63L8 12.25 4.47 14.1a.6.6 0 0 1-.87-.63l.68-3.94-2.86-2.8a.6.6 0 0 1 .33-1.03l3.95-.55 1.75-3.6A.6.6 0 0 1 8 1.2Z",home:"M7.5 1.6a.8.8 0 0 1 1 0l5.7 4.6a.8.8 0 0 1 .3.6v6.7a1 1 0 0 1-1 1H10V10.3H6v4.2H2.5a1 1 0 0 1-1-1V6.8a.8.8 0 0 1 .3-.6Z",gear:"M6.67 2.46L7.03 0.81L8.97 0.81L9.33 2.46L10.98 3.14L12.40 2.24L13.76 3.60L12.86 5.02L13.54 6.67L15.19 7.03L15.19 8.97L13.54 9.33L12.86 10.98L13.76 12.40L12.40 13.76L10.98 12.86L9.33 13.54L8.97 15.19L7.03 15.19L6.67 13.54L5.02 12.86L3.60 13.76L2.24 12.40L3.14 10.98L2.46 9.33L0.81 8.97L0.81 7.03L2.46 6.67L3.14 5.02L2.24 3.60L3.60 2.24L5.02 3.14ZM5.60 8.00a2.40 2.40 0 1 0 4.80 0a2.40 2.40 0 1 0 -4.80 0Z",calendar:"M3.5 2h9A2 2 0 0 1 14.5 4v8.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm-.5 4.5v6a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-6ZM4.2 7.6h1.6v1.6h-1.6ZM7.2 7.6h1.6v1.6h-1.6ZM10.2 7.6h1.6v1.6h-1.6ZM4.2 10.2h1.6v1.6h-1.6ZM7.2 10.2h1.6v1.6h-1.6ZM10.2 10.2h1.6v1.6h-1.6Z",send:"M14.3 1.7a.55.55 0 0 0-.6-.12L1.75 6.4a.55.55 0 0 0 0 1.02l4.6 1.85 4.9-4.13a.2.2 0 0 1 .28.28L7.4 10.3l1.84 4.6a.55.55 0 0 0 1.02 0l4.83-11.95a.55.55 0 0 0-.12-.6Z",mail:"M2.5 3h11A1.5 1.5 0 0 1 15 4.4L8 8.9 1 4.4A1.5 1.5 0 0 1 2.5 3ZM1 6.1v5.4A1.5 1.5 0 0 0 2.5 13h11a1.5 1.5 0 0 0 1.5-1.5V6.1l-6.6 4.2a.8.8 0 0 1-.8 0Z"};function Es({name:e,size:a=16,stroke:t=1.5,filled:n,className:r,style:o}){let s=n?n1[e]:void 0,l=`ss-icon${r?` ${r}`:""}`;if(!s&&e in Rp){let u=Rp[e];return i(u,{size:a,strokeWidth:t,absoluteStrokeWidth:!0,className:l,style:o,"aria-hidden":!0})}return i("svg",{viewBox:"0 0 16 16",width:a,height:a,className:l,style:o,"aria-hidden":!0,children:s?i("path",{d:s,fill:"currentColor",fillRule:"evenodd"}):i("path",{d:t1[e],fill:"none",stroke:"currentColor",strokeWidth:t,strokeLinecap:"round",strokeLinejoin:"round"})})}ia();var Fp=document.createElement("style");Fp.textContent=`/* Check */

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
`;document.head.appendChild(Fp);function Dp({on:e,pending:a,size:t=16,className:n,...r}){return i("span",{...r,className:`ss-check${n?` ${n}`:""}`,"data-on":e||void 0,"data-pending":a&&!e||void 0,style:{width:t,height:t,...r.style},children:v("svg",{viewBox:"0 0 16 16",width:t,height:t,"aria-hidden":!0,children:[i("circle",{className:"ss-check__ring",cx:"8",cy:"8",r:"7.25"}),i("circle",{className:"ss-check__arc",cx:"8",cy:"8",r:"7.25",pathLength:1}),i("circle",{className:"ss-check__fill",cx:"8",cy:"8",r:"8"}),i("path",{className:"ss-check__tick",d:"M4.5 8.2 7 10.6l4.6-5",pathLength:1})]})})}var Bp=document.createElement("style");Bp.textContent=`/* Spinner */

@layer stageshow {
  .ss-spinner {
    flex: none;
    animation: ss-spin 0.8s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .ss-spinner { animation: none; }
  }
}
`;document.head.appendChild(Bp);function Ns({size:e=14,className:a,style:t,...n}){return v("svg",{...n,className:`ss-spinner${a?` ${a}`:""}`,viewBox:"0 0 16 16",width:e,height:e,style:t,"aria-hidden":!0,children:[i("circle",{cx:"8",cy:"8",r:"6.25",fill:"none",stroke:"currentColor",strokeOpacity:"0.18",strokeWidth:"1.5"}),i("path",{d:"M8 1.75a6.25 6.25 0 0 1 6.25 6.25",fill:"none",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round"})]})}var Ep=()=>window.matchMedia("(prefers-color-scheme: dark)");function oo(){let[e,a]=pe(()=>Ep().matches);return Ca(()=>{let t=Ep(),n=()=>a(t.matches);return t.addEventListener("change",n),()=>t.removeEventListener("change",n)},[]),e}function wa({children:e,className:a}){return i("span",{className:a,children:e.map((t,n)=>v("span",{children:[n>0&&" ",i("span",{className:"ph",children:t})]},n))})}function so({size:e=22}){return i("span",{className:"dz-mark",style:{width:e,height:e},"aria-hidden":!0,children:i("span",{})})}function Os({send:e,at:a,target:t="send"}){return v("div",{className:"dz-acts-cell",children:[v("div",{className:"dz-acts","data-off":e==="done"||void 0,children:[v("span",{className:"dz-btn dz-btn--send","data-target":t,"data-cursor":"pointer",children:[i("span",{className:"dz-layer","data-on":e==="idle"||void 0,children:"보내기"}),i("span",{className:"dz-layer","data-on":e==="busy"||void 0,children:i(Ns,{size:14})})]}),i("span",{className:"dz-btn",children:"고치기"}),i("span",{className:"dz-btn dz-btn--text",children:"보내지 않기"})]}),v("div",{className:"dz-sent","data-off":e!=="done"||void 0,children:[i(Dp,{on:e==="done",size:16}),"보냈어요",i("span",{className:"dz-sent__time",children:a})]})]})}var Np=document.createElement("style");Np.textContent=`.hz-win {
  position: absolute;
  top: 8px;
  left: 24px;
  width: 952px;
  height: 584px;
  box-shadow: var(--ss-shadow-hero);
}

.hz-app {
  display: grid;
  grid-template-columns: 208px minmax(0, 1fr);
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

.hz-side {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
  padding: 12px;
}
.hz-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 10px;
  font-size: 15px;
  font-weight: 600;
}
.hz-pc {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
}
.hz-nav { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
.hz-ni {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 10px;
  border-radius: var(--r-ctl);
  color: var(--body);
  font-size: 14px;
  font-weight: 500;
}
.hz-ni[data-on] { background: var(--surface); color: var(--ink); font-weight: 700; }
.hz-nb {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--warn);
  color: var(--bg);
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
}
.hz-ni .hz-nb { margin-left: auto; }
.hz-use {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
  padding: 0 10px 8px;
  color: var(--muted);
  font-size: 12px;
}
.hz-use__bar { flex: 1; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
.hz-use__bar i { display: block; width: 18%; height: 100%; background: var(--warn); }

.hz-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.hz-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 52px;
  padding: 0 16px 0 8px;
}
.hz-bar h2 {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--ink);
  font-size: 20px;
  font-weight: 700;
  line-height: 28px;
  letter-spacing: -0.02em;
}
.hz-cmdk {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 6px 0 10px;
  border-radius: var(--r-ctl);
  background: var(--surface);
  color: var(--muted);
  font-size: 13px;
}
.hz-cmdk kbd {
  padding: 0 5px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: var(--surface-2);
  font: 500 11px/16px var(--font-sans);
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
  color: var(--bg);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
}
.hz-gw {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border-radius: 14px;
  background: var(--surface);
  color: var(--body);
  font-size: 12px;
  font-weight: 500;
}

.hz-cv {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin: 0 16px 16px 8px;
  border-radius: var(--r-card);
  background: var(--surface);
  overflow: hidden;
}
.hz-cvh { flex: none; display: flex; align-items: baseline; gap: 8px; padding: 14px 20px 8px; }
.hz-cvh b { font-size: 16px; font-weight: 600; }
.hz-cvh span { color: var(--muted); font-size: 12px; }

.hz-thread {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 14px;
  min-height: 0;
  padding: 0 20px 12px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 36px);
  mask-image: linear-gradient(to bottom, transparent, #000 36px);
}
.hz-thread > * { will-change: transform; flex: none; }

.hz-msg { display: flex; flex-direction: column; gap: 4px; }
.hz-me { align-items: flex-end; }
.hz-mm { color: var(--muted); font-size: 12px; line-height: 16px; }
.hz-mm b { color: var(--ink); font-weight: 600; }
.hz-bub {
  max-width: 80%;
  padding: 9px 14px;
  border-radius: 18px 18px 6px 18px;
  background: var(--surface-2);
  color: var(--ink);
  font-size: 13.5px;
  line-height: 1.45;
}
.hz-text { color: var(--ink); font-size: 14px; line-height: 1.55; }
.hz-sys {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: fit-content;
  margin: 0 auto;
  padding: 4px 12px;
  border-radius: 12px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 12px;
  line-height: 16px;
}
.hz-sys .ss-icon { color: var(--accent); }

.hz-q {
  display: grid;
  gap: 6px;
  max-width: 440px;
  padding: 10px 14px;
  border-radius: 14px;
  background: var(--surface-2);
}
.hz-q__hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hz-q__hd .hz-mm b { font-weight: 500; }
.hz-q__body { color: var(--body); font-size: 13px; line-height: 1.55; }

.hz-dock {
  display: grid;
  gap: 10px;
  margin: 0 12px 8px;
  padding: 12px 14px;
  border-radius: 16px;
  background: var(--surface-2);
}
.hz-dock__q { display: flex; align-items: center; gap: 8px; }
.hz-dock__t { color: var(--ink); font-size: 14px; font-weight: 600; line-height: 1.4; }
.hz-dock .dz-btn:not(.dz-btn--send):not(.dz-btn--text) { background: var(--surface); }

.hz-cmp { flex: none; padding: 4px 12px 12px; }
.hz-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 46px;
  padding: 0 6px 0 14px;
  border-radius: 18px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 14px;
}
.hz-send {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  opacity: 0.3;
}

.hz-tabbar {
  flex: none;
  display: flex;
  height: 50px;
  border-top: 1px solid var(--line);
  background: var(--surface);
}
.hz-tab {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: var(--muted);
  font-size: 10px;
  line-height: 13px;
}
.hz-tab svg { width: 16px; height: 16px; }
.hz-tab[data-on] { color: var(--ink); font-weight: 600; }
.hz-tab[data-on]::before {
  content: "";
  position: absolute;
  top: -1px;
  left: 28%;
  right: 28%;
  height: 2px;
  border-radius: 0 0 2px 2px;
  background: var(--accent);
}
.hz-tab .hz-nb {
  position: absolute;
  top: 4px;
  left: calc(50% + 4px);
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 10.5px;
  line-height: 16px;
}

.hz .ss-stage[data-layout='compact'] .hz-win {
  left: 8px;
  width: 342px;
  height: 544px;
}
.hz .ss-stage[data-layout='compact'] .hz-app { display: flex; flex-direction: column; }
.hz .ss-stage[data-layout='compact'] .hz-main { flex: 1; }
.hz .ss-stage[data-layout='compact'] .hz-bar { height: 46px; padding: 0 4px 0 14px; }
.hz .ss-stage[data-layout='compact'] .hz-cmdk { width: 32px; padding: 0; justify-content: center; background: transparent; }
.hz .ss-stage[data-layout='compact'] .hz-cmdk span,
.hz .ss-stage[data-layout='compact'] .hz-cmdk kbd { display: none; }
.hz .ss-stage[data-layout='compact'] .hz-cv { margin: 0 8px 8px; }
.hz .ss-stage[data-layout='compact'] .hz-cvh { padding: 12px 16px 6px; }
.hz .ss-stage[data-layout='compact'] .hz-thread { padding: 0 16px 10px; }
.hz .ss-stage[data-layout='compact'] .hz-dock { margin: 0 8px 6px; padding: 10px 12px; }
.hz .ss-stage[data-layout='compact'] .hz-cmp { padding: 4px 8px 8px; }
.hz .ss-stage[data-layout='compact'] .hz-box { height: 42px; }
.hz .ss-stage[data-layout='compact'] .hz-text { font-size: 13.5px; }
.hz .ss-stage[data-layout='compact'] .dz-btn { padding: 0 11px; }
.hz .ss-stage[data-layout='compact'] .dz-btn--text { padding: 0 6px; }
`;document.head.appendChild(Np);var r1={mail:!1,summary:!1,draft:!1,dock:!1,send:"idle"},o1={mail:!0,summary:!0,draft:!0,dock:!1,send:"done"};async function s1(e){await e.wait(700),e.put({mail:!0}),await e.wait(1100),e.put({summary:!0}),await e.wait(1300),e.put({draft:!0,dock:!0}),await e.wait(1500),await e.click({at:"send",x:0.55,y:0.6}),e.put({send:"busy"}),await e.wait(800),e.put({send:"done"}),await e.move({wide:{x:900,y:470},compact:{x:320,y:470}}),await e.wait(900),e.put({dock:!1}),await e.wait(2000),e.put({draft:!1}),await e.wait(70),e.put({summary:!1}),await e.wait(70),e.put({mail:!1}),await e.wait(700),e.put({send:"idle"})}var lo={size:18,strokeWidth:1.75,absoluteStrokeWidth:!0,"aria-hidden":!0},Op=[{name:"홈",icon:i(za,{...lo})},{name:"채팅",icon:i(Vr,{...lo}),badge:"1",on:!0},{name:"프로젝트",icon:i(Nr,{...lo})},{name:"모니터링",icon:i(Br,{...lo})},{name:"설정",icon:i(Qr,{...lo})}];function l1(){return v("div",{className:"hz-side",children:[v("div",{className:"hz-brand",children:[i(so,{size:18}),"dotz",v("span",{className:"hz-pc",children:[i(kn,{size:14,"aria-hidden":!0}),"맥북",i(Bt,{size:14,"aria-hidden":!0})]})]}),i("nav",{className:"hz-nav",children:Op.map((e)=>v("span",{className:"hz-ni","data-on":e.on||void 0,children:[e.icon,e.name,e.badge&&i("span",{className:"hz-nb",children:e.badge})]},e.name))}),v("div",{className:"hz-use",children:["사용량",i("span",{className:"hz-use__bar",children:i("i",{})}),i("span",{children:"7일 18%"})]})]})}function u1(){return i("div",{className:"hz-tabbar",children:Op.map((e)=>v("span",{className:"hz-tab","data-on":e.on||void 0,children:[e.icon,e.name,e.badge&&i("span",{className:"hz-nb",children:e.badge})]},e.name))})}function yi(){let e=oo();return i(Bs,{className:"dz hz",width:1000,height:600,compact:{below:600,width:358,height:560},fill:!0,theme:e?"dark":"light",initial:r1,poster:o1,script:s1,play:"loop",cursor:{at:{wide:{x:900,y:470},compact:{x:320,y:470}}},children:(a,t,n)=>i(Ap,{title:"dotz",className:"hz-win",children:v("div",{className:"hz-app",children:[n==="wide"&&i(l1,{}),v("div",{className:"hz-main",children:[v("div",{className:"hz-bar",children:[i("h2",{children:"채팅"}),n==="compact"&&v("span",{className:"hz-gw",children:[i(kn,{size:13,"aria-hidden":!0}),"맥북"]}),v("span",{className:"hz-cmdk",children:[i(Et,{size:15,"aria-hidden":!0}),i("span",{children:"검색"}),i("kbd",{children:"⌘K"})]}),v("span",{className:"hz-bell",children:[i(Dt,{size:18,strokeWidth:1.75,"aria-hidden":!0}),i("span",{className:"hz-bd",children:"1"})]})]}),v("div",{className:"hz-cv",children:[v("div",{className:"hz-cvh",children:[i("b",{children:"dotz"}),i("span",{children:"대기"})]}),v("div",{className:"hz-thread",children:[v("div",{className:"hz-msg hz-me",children:[i("span",{className:"hz-bub",children:i(wa,{children:["새 메일이 오면","요약하고 답장 초안 써 줘"]})}),i("span",{className:"hz-mm",children:"오전 9:12"})]}),v("div",{className:"hz-msg",children:[v("span",{className:"hz-mm",children:[i("b",{children:"dotz"})," · 오전 9:12"]}),i(wa,{className:"hz-text",children:["알겠어요.","보내기 전에 꼭 물어볼게요."]})]}),i(Ve,{open:a.mail,reveal:"drop",from:"below",children:v("div",{className:"hz-sys",children:[i(Es,{name:"mail",size:13}),i("span",{children:"새 메일 · 한지우 · 다음 주 촬영 일정"})]})}),i(Ve,{open:a.summary,reveal:"drop",from:"below",children:v("div",{className:"hz-msg",children:[v("span",{className:"hz-mm",children:[i("b",{children:"dotz"})," · 오전 9:41"]}),i(wa,{className:"hz-text",children:["한지우 님이","다음 주 화요일 오후에","촬영이 되는지 물어봤어요."]})]})}),i(Ve,{open:a.draft,reveal:"drop",from:"below",children:v("div",{className:"hz-q",children:[v("div",{className:"hz-q__hd",children:[v("span",{className:"hz-mm",children:["답장 초안 · ",i("b",{children:"한지우"})]}),v("span",{className:"dz-swap",children:[i("span",{className:"dz-tag dz-tag--warn","data-off":a.send==="done"||void 0,children:"확인 필요"}),i("span",{className:"dz-tag dz-tag--ok","data-off":a.send!=="done"||void 0,children:"보냈어요"})]})]}),i(wa,{className:"hz-q__body",children:["화요일 오후 2시 좋아요.","성수 스튜디오에서 뵐게요."]})]})})]}),i(Ve,{open:a.dock,reveal:"drop",from:"below",children:v("div",{className:"hz-dock",children:[v("div",{className:"hz-dock__q",children:[i("span",{className:"dz-tag dz-tag--warn",children:"확인 필요"}),i(wa,{className:"hz-dock__t",children:["한지우 님께","이 답장을 보낼까요?"]})]}),i(Os,{send:a.send,at:"오전 9:42"})]})}),i("div",{className:"hz-cmp",children:v("div",{className:"hz-box",children:[i("span",{children:"dotz에게 말해 보세요"}),i("span",{className:"hz-send",children:i(Ar,{size:16,strokeWidth:2,"aria-hidden":!0})})]})})]})]}),n==="compact"&&i(u1,{})]})})})}ia();var Up=document.createElement("style");Up.textContent=`/* Phones (phone.tsx): frames, the status bar, the lock screen and
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
`;document.head.appendChild(Up);var i1={w:402,h:874,r:64},Hp={a:71,n:2.31},d1={w:393,h:829,r:42},f1={w:412,h:915,r:38},c1={pro:{band:3,glass:10},photo:{band:0,glass:16},bezel:{band:0,glass:12},soft:{band:0,glass:12.5},bare:{band:0,glass:0},silver:{band:4,glass:9},clay:{band:0,glass:16},outline:{band:0,glass:8},android:{band:2,glass:9}},p1={pro:[[13,"band"],[10,"var(--ss-phone-rim)"],[9.25,"var(--ss-phone-glass)"]],silver:[[13,"band"],[9,"var(--ss-phone-glass)"]],bezel:[[12,"var(--ss-phone-glass)"]],clay:[[16,"clay"],[1,"var(--ss-phone-seam)"]]};function m1(e,a,t,n){let o=2/n,s=[];return[[e-t,t,1,-1],[e-t,a-t,1,1],[t,a-t,-1,1],[t,t,-1,-1]].forEach(([u,c,m,g],h)=>{for(let w=0;w<=32;w++){let x=w/32*(Math.PI/2),k=h%2===0?Math.sin(x):Math.cos(x),B=h%2===0?Math.cos(x):Math.sin(x);s.push(`${(u+m*t*Math.pow(k,o)).toFixed(2)} ${(c+g*t*Math.pow(B,o)).toFixed(2)}`)}}),`M${s.join("L")}Z`}function qp({width:e,frame:a="pro",time:t="9:41",island:n,status:r,dark:o,wallpaper:s,className:l,style:u,children:c,...m}){let g=Z(null),[h,w]=pe(!0);Ca(()=>{if(a!=="photo"||!g.current)return;let Le=getComputedStyle(g.current).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/)?.[1];if(!Le)return void w(!1);let La=!0,Ge=new Image;return Ge.onerror=()=>La&&w(!1),Ge.src=Le,()=>{La=!1}},[a,o]);let x=a==="photo"&&!h?"pro":a,{band:k,glass:B}=c1[x],{fidelity:f}=wi(),d=x==="android"?f1:x==="soft"?d1:i1,p=k+B,L=e/(d.w+p*2),I=(Fe)=>Fe*L,T=Qs().replace(/:/g,""),y=x!=="android"&&x!=="soft"?m1(I(d.w),I(d.h),I(Hp.a),Hp.n):null,Q=p1[x],D=x==="pro"||x==="photo"||x==="bezel"||x==="silver"||x==="android",V=n??(D&&x!=="photo"),oa=r??D;return v("div",{...m,className:`ss-phone${l?` ${l}`:""}`,"data-frame":x,"data-dark":o||void 0,style:{width:e,height:I(d.h+p*2),padding:I(k),borderRadius:I(d.r+p),["--ps"]:`${L}px`,...u},children:[(Q||x==="outline")&&y&&v("svg",{className:"ss-phone__bands",width:"100%",height:"100%","aria-hidden":!0,children:[v("defs",{children:[i("linearGradient",{id:`${T}-band`,x1:"0.2",y1:"0",x2:"0.8",y2:"1",children:[0,0.22,0.48,0.74,1].map((Fe,Le)=>i("stop",{offset:Fe,style:{stopColor:`var(--ss-phone-band-${Le+1})`}},Fe))}),v("linearGradient",{id:`${T}-clay`,x1:"0",y1:"0",x2:"0",y2:"1",children:[i("stop",{offset:"0",style:{stopColor:"var(--ss-phone-clay-top)"}}),i("stop",{offset:"1",style:{stopColor:"var(--ss-phone-clay-bottom)"}})]}),x==="outline"&&v("mask",{id:`${T}-ring`,maskUnits:"userSpaceOnUse",x:"-50%",y:"-50%",width:"200%",height:"200%",children:[i("path",{d:y,fill:"none",stroke:"#fff",strokeWidth:I(16)}),i("path",{d:y,fill:"none",stroke:"#000",strokeWidth:I(16)-2})]})]}),i("g",{transform:`translate(${I(p)} ${I(p)})`,strokeLinejoin:"round",children:x==="outline"?v(Ta,{children:[i("rect",{x:-I(9),y:-I(9),width:I(d.w+18),height:I(d.h+18),mask:`url(#${T}-ring)`,style:{fill:"var(--ss-phone-line)"}}),i("path",{d:y,fill:"none",strokeWidth:"2",style:{stroke:"var(--ss-line, rgba(0, 0, 0, 0.06))"}})]}):Q.map(([Fe,Le])=>i("path",{d:y,fill:"none",strokeWidth:I(Fe*2),stroke:Le==="band"||Le==="clay"?`url(#${T}-${Le})`:void 0,style:Le==="band"||Le==="clay"?void 0:{stroke:Le}},Fe))})]}),i("div",{className:"ss-phone__glass",style:{padding:I(B),borderRadius:I(d.r+B)},children:i("div",{className:"ss-phone__window",style:{width:I(d.w),height:I(d.h),borderRadius:y?void 0:I(d.r),clipPath:y?`path('${y}')`:void 0},children:v("div",{className:"ss-phone__screen",style:{width:d.w,height:d.h,transform:`scale(${L})`,["--ss-screen-r"]:`${d.r}px`,...s?{background:s}:null},children:[oa&&v("div",{className:"ss-phone__status",children:[i("span",{className:"ss-phone__time",children:f==="minimal"?i("span",{className:"ss-phone__time-bar"}):t}),v("span",{className:"ss-phone__glyphs",children:[i(h1,{}),i(g1,{}),i(x1,{})]})]}),V&&i("span",{className:"ss-phone__island"}),i("div",{className:"ss-phone__content","data-status":oa||void 0,children:c}),D&&i("span",{className:"ss-phone__home"})]})})}),x==="photo"&&i("span",{ref:g,className:"ss-phone__photo",style:{left:I(-8),top:I(-7),width:I(450),height:I(920)}})]})}function h1(){return i("svg",{viewBox:"0 0 20.33 13.67",width:"20.33",height:"13.67",className:"ss-phone__glyph ss-phone__signal",children:[6.33,8.67,11,13.67].map((e,a)=>i("rect",{x:a*5.667,y:13.67-e,width:3.333,height:e,rx:1.667,fill:"currentColor"},a))})}function g1(){return i("svg",{viewBox:"0 0 19.33 14.33",width:"19.33",height:"14.33",className:"ss-phone__glyph ss-phone__wifi",children:i("path",{fillRule:"evenodd",fill:"currentColor",d:"M0.415933 5.54283C0.902185 6.04412 1.66017 5.95818 2.27513 5.41393C4.30595 3.58064 6.83731 2.63535 9.66901 2.63535C12.5007 2.63535 15.0464 3.60928 17.0629 5.41393C17.6636 5.97251 18.4215 6.0298 18.9221 5.54283C19.4226 5.02722 19.4942 4.2538 18.9793 3.70954C16.8341 1.51819 13.3302 0 9.66901 0C6.00783 0 2.48965 1.53251 0.358727 3.72387C-0.156127 4.2538 -0.0989213 5.02722 0.415933 5.55715L0.415933 5.54283ZM3.94841 9.13779C4.50617 9.68205 5.22124 9.62476 5.85051 9.10915C6.88022 8.29276 8.25316 7.73418 9.66901 7.7485C11.0706 7.7485 12.4435 8.29276 13.4875 9.12347C14.1168 9.63908 14.8605 9.66773 15.4039 9.12347C15.9331 8.57921 16.0189 7.7485 15.4611 7.23289C14.0739 5.98683 11.9859 5.11315 9.68332 5.11315C7.38077 5.11315 5.27845 5.98683 3.9055 7.23289C3.41925 7.69121 3.31914 8.47896 3.96271 9.13779L3.94841 9.13779ZM8.72511 13.8929C9.34008 14.4801 9.98365 14.4801 10.5986 13.8929L11.757 12.7757C12.372 12.1742 12.5007 11.4151 11.7999 10.8995C11.2136 10.4841 10.4699 10.212 9.66901 10.212C8.86813 10.212 8.11015 10.4841 7.53809 10.9138C6.83731 11.4151 6.98033 12.1885 7.59529 12.7757L8.73942 13.8929L8.72511 13.8929Z"})})}function x1(){return v("svg",{viewBox:"0 0 29.33 13.67",width:"29.33",height:"13.67",className:"ss-phone__glyph ss-phone__battery",children:[i("path",{fill:"currentColor",d:"M0 6.4C0 4.15979 0 3.03969 0.435974 2.18404C0.819467 1.43139 1.43139 0.819467 2.18404 0.435974C3.03969 0 4.15979 0 6.4 0L19.933 0C22.1732 0 23.2933 0 24.149 0.435974C24.9016 0.819467 25.5135 1.43139 25.897 2.18404C26.333 3.03969 26.333 4.15979 26.333 6.4L26.333 7.26666C26.333 9.50687 26.333 10.627 25.897 11.4826C25.5135 12.2353 24.9016 12.8472 24.149 13.2307C23.2933 13.6667 22.1732 13.6667 19.933 13.6667L6.4 13.6667C4.15979 13.6667 3.03969 13.6667 2.18404 13.2307C1.43139 12.8472 0.819467 12.2353 0.435974 11.4826C0 10.627 0 9.50687 0 7.26666L0 6.4Z"}),i("path",{fillRule:"evenodd",fill:"currentColor",transform:"translate(27.33 4.33)",d:"M0 0L0 5C0.601505 4.8625 2 3.75 2 2.5C2 1.25 0.601505 0.1375 0 0Z"})]})}var Wp=document.createElement("style");Wp.textContent=`.cz .ss-stage { overflow: hidden; }

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

.cz-head { display: flex; align-items: center; gap: 8px; }
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

.cz-draft { max-width: 400px; padding: 12px 14px; }
.cz-draft .dz-btn--send { transition: box-shadow var(--m-slow) var(--m-ease); }
.cz-draft[data-wait] .dz-btn--send { box-shadow: 0 0 0 4px var(--accent-soft); }


.cz-phone { margin-top: 4px; }
/* the kit draws a phone screen in iPhone points and scales it down to 250px */
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

.cz--phone .ss-stage .cz-panel { left: 0; width: 100%; align-items: center; padding: 0; background: transparent; }
`;document.head.appendChild(Wp);function vi({name:e,initial:a,poster:t,script:n,bare:r,children:o}){let s=oo();return i(Bs,{className:`dz cz cz--${e}`,width:520,height:280,compact:{below:440,width:350,height:270},theme:s?"dark":"light",initial:a,poster:t,script:n,play:"loop",fill:!0,children:(l)=>i("div",{className:`cz-panel${r?" cz-panel--bare":""}`,children:o(l)})})}function Gp(){return i(vi,{name:"mail",initial:{mail:!1,summary:!1,draft:!1,wait:!1},poster:{mail:!0,summary:!0,draft:!0,wait:!0},script:async(e)=>{await e.wait(500),e.put({mail:!0}),await e.wait(900),e.put({summary:!0}),await e.wait(1000),e.put({draft:!0}),await e.wait(800),e.put({wait:!0}),await e.wait(3200),e.put({wait:!1,draft:!1}),await e.wait(70),e.put({summary:!1}),await e.wait(70),e.put({mail:!1}),await e.wait(600)},children:(e)=>v(Ta,{children:[i(Ve,{open:e.mail,reveal:"drop",from:"below",children:v("div",{className:"cz-chip",children:[i(Es,{name:"mail",size:13}),i(wa,{children:["새 메일 · 한지우","· 다음 주 촬영 일정"]})]})}),i(Ve,{open:e.summary,reveal:"drop",from:"below",children:v("div",{className:"cz-head",children:[i(so,{size:22}),i(wa,{className:"cz-text",children:["화요일 오후에","촬영이 되는지 묻는 메일이에요."]})]})}),i(Ve,{open:e.draft,reveal:"drop",from:"below",children:v("div",{className:"dz-draft cz-draft","data-wait":e.wait||void 0,children:[v("div",{className:"dz-draft__hd",children:[i("span",{className:"dz-draft__title",children:"답장 초안"}),i("span",{className:"dz-tag dz-tag--warn",children:"확인 필요"})]}),i("div",{className:"dz-draft__body",children:i(wa,{children:["화요일 오후 2시 좋아요."]})}),i(Os,{send:"idle",at:"방금"})]})})]})})}var Vp=[["10:00","팀 주간 회의"],["13:30","치과 예약"]];function jp(){let e=oo();return i(vi,{name:"phone",bare:!0,initial:{ask:!1,busy:!1,reply:!1,rows:0},poster:{ask:!0,busy:!1,reply:!0,rows:2},script:async(a)=>{await a.wait(500),a.put({ask:!0}),await a.wait(700),a.put({busy:!0}),await a.wait(1300),a.put({busy:!1,reply:!0}),await a.wait(500);for(let t=1;t<=Vp.length;t++)a.put({rows:t}),await a.wait(260);await a.wait(3000),a.put({rows:0}),await a.wait(70),a.put({reply:!1}),await a.wait(70),a.put({ask:!1}),await a.wait(600)},children:(a)=>i(qp,{width:250,frame:"bezel",time:"8:30",dark:e,wallpaper:"var(--surface)",className:"cz-phone",children:v("div",{className:"cz-chat",children:[v("div",{className:"cz-chat__hd",children:[i(so,{size:18}),i("b",{children:"dotz"})]}),i(Ve,{open:a.ask,reveal:"drop",from:"below",children:i("div",{className:"cz-me",children:i("span",{children:"오늘 일정 알려 줘"})})}),i(Ve,{open:a.busy,children:v("div",{className:"cz-busy",children:[i(Ns,{size:12}),"확인하는 중"]})}),i(Ve,{open:a.reply,reveal:"drop",from:"below",children:i(wa,{className:"cz-text",children:["오늘 일정은 두 개예요."]})}),i("div",{className:"cz-list",children:Vp.map(([t,n],r)=>i(Ve,{open:a.rows>r,children:v("div",{className:"cz-ev",children:[i("span",{className:"cz-ev__t",children:t}),i("span",{className:"cz-ev__title",children:n})]})},t))})]})})})}function $p(){return i(vi,{name:"watch",bare:!0,initial:{drop:!1,alert:!1},poster:{drop:!0,alert:!0},script:async(e)=>{await e.wait(1100),e.put({drop:!0}),await e.wait(1100),e.put({alert:!0}),await e.wait(3400),e.put({alert:!1}),await e.wait(200),e.put({drop:!1}),await e.wait(600)},children:(e)=>v(Ta,{children:[v("div",{className:"cz-watch",children:[v("span",{className:"cz-nt__b",children:[i("b",{children:"캠핑 의자"}),i("span",{children:"지켜보는 중"})]}),i("span",{className:"cz-amt",children:v("span",{className:"dz-swap",children:[i("span",{"data-off":e.drop||void 0,children:"89,000원"}),i("em",{"data-off":!e.drop||void 0,children:"72,000원"})]})})]}),i("div",{className:"cz-title",children:"알림"}),v("div",{className:"cz-nts",children:[i(Ve,{open:e.alert,reveal:"drop",children:v("div",{className:"cz-nt","data-unread":!0,children:[i("span",{className:"cz-nt__dot"}),v("span",{className:"cz-nt__b",children:[i("b",{children:"가격이 바뀌었어요"}),v("span",{className:"cz-price",children:["캠핑 의자 ",i("s",{children:"89,000원"})," → ",i("em",{children:"72,000원"})]})]}),i("span",{className:"cz-nt__time",children:"방금"})]})}),v("div",{className:"cz-nt",children:[i("span",{className:"cz-nt__dot"}),v("span",{className:"cz-nt__b",children:[i("b",{children:"로그인 유지"}),i("span",{children:"사이트 세 곳 · 바뀐 것 없음"})]}),i("span",{className:"cz-nt__time",children:"오전 8:00"})]})]})]})})}var w1={hero:yi,mail:Gp,phone:jp,watch:$p},L1=(e)=>{let a=w1[e.dataset.ss??""];if(!a)return;Kp.createRoot(e).render(i(a,{})),e.closest(".shot, .card")?.classList.add("ss-live")},Xp=new IntersectionObserver((e)=>{for(let a of e){if(!a.isIntersecting)continue;Xp.unobserve(a.target),L1(a.target)}},{rootMargin:"300px 0px"});for(let e of document.querySelectorAll("[data-ss]"))Xp.observe(e);
