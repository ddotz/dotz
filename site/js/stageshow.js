var am=Object.create;var{getPrototypeOf:nm,defineProperty:Mi,getOwnPropertyNames:rm}=Object;var _i=Object.prototype.hasOwnProperty;function om(e){return this[e]}var sm,lm,Ai=(e,t,a)=>{var n=e!=null&&typeof e==="object";if(n){var r=t?sm??=new WeakMap:lm??=new WeakMap,o=r.get(e);if(o)return o}a=e!=null?am(nm(e)):{};let s=t||!e||!e.__esModule||!_i.call(e,"default")?Mi(a,"default",{value:e,enumerable:!0}):a;if(e&&typeof e==="object"||typeof e==="function"){for(let l of rm(e))if(!_i.call(s,l))Mi(s,l,{get:om.bind(e,l),enumerable:!0})}if(n)r.set(e,s);return s};var zi=(e,t)=>()=>(t||e((t={exports:{}}).exports,t),t.exports);var Xs=(e,t,a)=>()=>{if(e)try{t=e(e=0)}catch(n){a=[n]}if(a)throw a[0];return t};function Mn(e,t,a){this.props=e,this.context=t,this.refs=Ri,this.updater=a||Ti}function Fi(){}function Di(e,t,a){this.props=e,this.context=t,this.refs=Ri,this.updater=a||Ti}function hm(e,t,a){var n,r={},o=null,s=null;if(t!=null)for(n in t.ref!==void 0&&(s=t.ref),t.key!==void 0&&(o=""+t.key),t)pm.call(t,n)&&!mm.hasOwnProperty(n)&&(r[n]=t[n]);var l=arguments.length-2;if(l===1)r.children=a;else if(1<l){for(var u=Array(l),c=0;c<l;c++)u[c]=arguments[c+2];r.children=u}if(e&&e.defaultProps)for(n in l=e.defaultProps,l)r[n]===void 0&&(r[n]=l[n]);return{$$typeof:um,type:e,key:o,ref:s,props:r,_owner:Bi.current}}var um,im,dm,fm,Ti,cm,Ri,Zs,pm,Bi,mm,Ft,gm,xm,_n,An=function(e){return e={$$typeof:dm,_currentValue:e,_currentValue2:e,_threadCount:0,Provider:null,Consumer:null,_defaultValue:null,_globalName:null},e.Provider={$$typeof:im,_context:e},e.Consumer=e},ja,zn=function(e){return{$$typeof:fm,render:e}},Dt=function(e,t){return Ft.current.useCallback(e,t)},Tn=function(e){return Ft.current.useContext(e)},Ct=function(e,t){return Ft.current.useEffect(e,t)},Qs=function(){return Ft.current.useId()},ut=function(e,t){return Ft.current.useLayoutEffect(e,t)},po=function(e,t){return Ft.current.useMemo(e,t)},Z=function(e){return Ft.current.useRef(e)},pe=function(e){return Ft.current.useState(e)};var it=Xs(()=>{um=Symbol.for("react.element"),im=Symbol.for("react.provider"),dm=Symbol.for("react.context"),fm=Symbol.for("react.forward_ref"),Ti={isMounted:function(){return!1},enqueueForceUpdate:function(){},enqueueReplaceState:function(){},enqueueSetState:function(){}},cm=Object.assign,Ri={};Mn.prototype.isReactComponent={};Mn.prototype.setState=function(e,t){if(typeof e!=="object"&&typeof e!=="function"&&e!=null)throw Error("setState(...): takes an object of state variables to update or a function which returns an object of state variables.");this.updater.enqueueSetState(this,e,t,"setState")};Mn.prototype.forceUpdate=function(e){this.updater.enqueueForceUpdate(this,e,"forceUpdate")};Fi.prototype=Mn.prototype;Zs=Di.prototype=new Fi;Zs.constructor=Di;cm(Zs,Mn.prototype);Zs.isPureReactComponent=!0;pm=Object.prototype.hasOwnProperty,Bi={current:null},mm={key:!0,ref:!0,__self:!0,__source:!0};Ft={current:null},gm={transition:null},xm={ReactCurrentDispatcher:Ft,ReactCurrentBatchConfig:gm,ReactCurrentOwner:Bi};_n=xm,ja=hm});var Vi=zi(function(Ka){function Js(e,t){var a=e.length;e.push(t);e:for(;0<a;){var n=a-1>>>1,r=e[n];if(0<mo(r,t))e[n]=t,e[a]=r,a=n;else break e}}function dt(e){return e.length===0?null:e[0]}function wo(e){if(e.length===0)return null;var t=e[0],a=e.pop();if(a!==t){e[0]=a;e:for(var n=0,r=e.length,o=r>>>1;n<o;){var s=2*(n+1)-1,l=e[s],u=s+1,c=e[u];if(0>mo(l,a))u<r&&0>mo(c,l)?(e[n]=c,e[u]=a,n=u):(e[n]=l,e[s]=a,n=s);else if(u<r&&0>mo(c,a))e[n]=c,e[u]=a,n=u;else break e}}return t}function mo(e,t){var a=e.sortIndex-t.sortIndex;return a!==0?a:e.id-t.id}if(typeof performance==="object"&&typeof performance.now==="function")el=performance,Ka.unstable_now=function(){return el.now()};else ho=Date,tl=ho.now(),Ka.unstable_now=function(){return ho.now()-tl};var el,ho,tl,St=[],Gt=[],wm=1,Ye=null,_e=3,Lo=!1,ya=!1,Fn=!1,Oi=typeof setTimeout==="function"?setTimeout:null,Ui=typeof clearTimeout==="function"?clearTimeout:null,Ni=typeof setImmediate<"u"?setImmediate:null;typeof navigator<"u"&&navigator.scheduling!==void 0&&navigator.scheduling.isInputPending!==void 0&&navigator.scheduling.isInputPending.bind(navigator.scheduling);function al(e){for(var t=dt(Gt);t!==null;){if(t.callback===null)wo(Gt);else if(t.startTime<=e)wo(Gt),t.sortIndex=t.expirationTime,Js(St,t);else break;t=dt(Gt)}}function rl(e){if(Fn=!1,al(e),!ya)if(dt(St)!==null)ya=!0,sl(ol);else{var t=dt(Gt);t!==null&&ll(rl,t.startTime-e)}}function ol(e,t){ya=!1,Fn&&(Fn=!1,Ui(Dn),Dn=-1),Lo=!0;var a=_e;try{al(t);for(Ye=dt(St);Ye!==null&&(!(Ye.expirationTime>t)||e&&!Wi());){var n=Ye.callback;if(typeof n==="function"){Ye.callback=null,_e=Ye.priorityLevel;var r=n(Ye.expirationTime<=t);t=Ka.unstable_now(),typeof r==="function"?Ye.callback=r:Ye===dt(St)&&wo(St),al(t)}else wo(St);Ye=dt(St)}if(Ye!==null)var o=!0;else{var s=dt(Gt);s!==null&&ll(rl,s.startTime-t),o=!1}return o}finally{Ye=null,_e=a,Lo=!1}}var yo=!1,go=null,Dn=-1,Hi=5,qi=-1;function Wi(){return Ka.unstable_now()-qi<Hi?!1:!0}function Ys(){if(go!==null){var e=Ka.unstable_now();qi=e;var t=!0;try{t=go(!0,e)}finally{t?Rn():(yo=!1,go=null)}}else yo=!1}var Rn;if(typeof Ni==="function")Rn=function(){Ni(Ys)};else if(typeof MessageChannel<"u")xo=new MessageChannel,nl=xo.port2,xo.port1.onmessage=Ys,Rn=function(){nl.postMessage(null)};else Rn=function(){Oi(Ys,0)};var xo,nl;function sl(e){go=e,yo||(yo=!0,Rn())}function ll(e,t){Dn=Oi(function(){e(Ka.unstable_now())},t)}Ka.unstable_IdlePriority=5;Ka.unstable_ImmediatePriority=1;Ka.unstable_LowPriority=4;Ka.unstable_NormalPriority=3;Ka.unstable_Profiling=null;Ka.unstable_UserBlockingPriority=2;Ka.unstable_cancelCallback=function(e){e.callback=null};Ka.unstable_continueExecution=function(){ya||Lo||(ya=!0,sl(ol))};Ka.unstable_forceFrameRate=function(e){0>e||125<e?console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"):Hi=0<e?Math.floor(1000/e):5};Ka.unstable_getCurrentPriorityLevel=function(){return _e};Ka.unstable_getFirstCallbackNode=function(){return dt(St)};Ka.unstable_next=function(e){switch(_e){case 1:case 2:case 3:var t=3;break;default:t=_e}var a=_e;_e=t;try{return e()}finally{_e=a}};Ka.unstable_pauseExecution=function(){};Ka.unstable_requestPaint=function(){};Ka.unstable_runWithPriority=function(e,t){switch(e){case 1:case 2:case 3:case 4:case 5:break;default:e=3}var a=_e;_e=e;try{return t()}finally{_e=a}};Ka.unstable_scheduleCallback=function(e,t,a){var n=Ka.unstable_now();switch(typeof a==="object"&&a!==null?(a=a.delay,a=typeof a==="number"&&0<a?n+a:n):a=n,e){case 1:var r=-1;break;case 2:r=250;break;case 5:r=1073741823;break;case 4:r=1e4;break;default:r=5000}return r=a+r,e={id:wm++,callback:t,priorityLevel:e,startTime:a,expirationTime:r,sortIndex:-1},a>n?(e.sortIndex=a,Js(Gt,e),dt(St)===null&&e===dt(Gt)&&(Fn?(Ui(Dn),Dn=-1):Fn=!0,ll(rl,a-n))):(e.sortIndex=r,Js(St,e),ya||Lo||(ya=!0,sl(ol))),e};Ka.unstable_shouldYield=Wi;Ka.unstable_wrapCallback=function(e){var t=_e;return function(){var a=_e;_e=t;try{return e.apply(this,arguments)}finally{_e=a}}}});function S(e){for(var t="https://reactjs.org/docs/error-decoder.html?invariant="+e,a=1;a<arguments.length;a++)t+="&args[]="+encodeURIComponent(arguments[a]);return"Minified React error #"+e+"; visit "+t+" for the full message or use the non-minified dev environment for full errors and additional helpful warnings."}function Ra(e,t){mn(e,t),mn(e+"Capture",t)}function mn(e,t){ur[e]=t;for(e=0;e<t.length;e++)Kd.add(t[e])}function Nm(e){if(_l.call(ji,e))return!0;if(_l.call(Gi,e))return!1;if(Em.test(e))return ji[e]=!0;return Gi[e]=!0,!1}function Om(e,t,a,n){if(a!==null&&a.type===0)return!1;switch(typeof t){case"function":case"symbol":return!0;case"boolean":if(n)return!1;if(a!==null)return!a.acceptsBooleans;return e=e.toLowerCase().slice(0,5),e!=="data-"&&e!=="aria-";default:return!1}}function Um(e,t,a,n){if(t===null||typeof t>"u"||Om(e,t,a,n))return!0;if(n)return!1;if(a!==null)switch(a.type){case 3:return!t;case 4:return t===!1;case 5:return isNaN(t);case 6:return isNaN(t)||1>t}return!1}function Ne(e,t,a,n,r,o,s){this.acceptsBooleans=t===2||t===3||t===4,this.attributeName=n,this.attributeNamespace=r,this.mustUseProperty=a,this.propertyName=e,this.type=t,this.sanitizeURL=o,this.removeEmptyString=s}function Cu(e){return e[1].toUpperCase()}function Su(e,t,a,n){var r=Me.hasOwnProperty(t)?Me[t]:null;if(r!==null?r.type!==0:n||!(2<t.length)||t[0]!=="o"&&t[0]!=="O"||t[1]!=="n"&&t[1]!=="N")Um(t,a,r,n)&&(a=null),n||r===null?Nm(t)&&(a===null?e.removeAttribute(t):e.setAttribute(t,""+a)):r.mustUseProperty?e[r.propertyName]=a===null?r.type===3?!1:"":a:(t=r.attributeName,n=r.attributeNamespace,a===null?e.removeAttribute(t):(r=r.type,a=r===3||r===4&&a===!0?"":""+a,n?e.setAttributeNS(n,t,a):e.setAttribute(t,a)))}function Bn(e){if(e===null||typeof e!=="object")return null;return e=$i&&e[$i]||e["@@iterator"],typeof e==="function"?e:null}function Vn(e){if(ul===void 0)try{throw Error()}catch(a){var t=a.stack.trim().match(/\n( *(at )?)/);ul=t&&t[1]||""}return`
`+ul+e}function dl(e,t){if(!e||il)return"";il=!0;var a=Error.prepareStackTrace;Error.prepareStackTrace=void 0;try{if(t)if(t=function(){throw Error()},Object.defineProperty(t.prototype,"props",{set:function(){throw Error()}}),typeof Reflect==="object"&&Reflect.construct){try{Reflect.construct(t,[])}catch(c){var n=c}Reflect.construct(e,[],t)}else{try{t.call()}catch(c){n=c}e.call(t.prototype)}else{try{throw Error()}catch(c){n=c}e()}}catch(c){if(c&&n&&typeof c.stack==="string"){for(var r=c.stack.split(`
`),o=n.stack.split(`
`),s=r.length-1,l=o.length-1;1<=s&&0<=l&&r[s]!==o[l];)l--;for(;1<=s&&0<=l;s--,l--)if(r[s]!==o[l]){if(s!==1||l!==1)do if(s--,l--,0>l||r[s]!==o[l]){var u=`
`+r[s].replace(" at new "," at ");return e.displayName&&u.includes("<anonymous>")&&(u=u.replace("<anonymous>",e.displayName)),u}while(1<=s&&0<=l);break}}}finally{il=!1,Error.prepareStackTrace=a}return(e=e?e.displayName||e.name:"")?Vn(e):""}function Hm(e){switch(e.tag){case 5:return Vn(e.type);case 16:return Vn("Lazy");case 13:return Vn("Suspense");case 19:return Vn("SuspenseList");case 0:case 2:case 15:return e=dl(e.type,!1),e;case 11:return e=dl(e.type.render,!1),e;case 1:return e=dl(e.type,!0),e;default:return""}}function Rl(e){if(e==null)return null;if(typeof e==="function")return e.displayName||e.name||null;if(typeof e==="string")return e;switch(e){case Qa:return"Fragment";case Wn:return"Portal";case Al:return"Profiler";case bu:return"StrictMode";case zl:return"Suspense";case Tl:return"SuspenseList"}if(typeof e==="object")switch(e.$$typeof){case Zd:return(e.displayName||"Context")+".Consumer";case Xd:return(e._context.displayName||"Context")+".Provider";case Pu:var t=e.render;return e=e.displayName,e||(e=t.displayName||t.name||"",e=e!==""?"ForwardRef("+e+")":"ForwardRef"),e;case Mu:return t=e.displayName||null,t!==null?t:Rl(e.type)||"Memo";case $t:t=e._payload,e=e._init;try{return Rl(e(t))}catch(a){}}return null}function qm(e){var t=e.type;switch(e.tag){case 24:return"Cache";case 9:return(t.displayName||"Context")+".Consumer";case 10:return(t._context.displayName||"Context")+".Provider";case 18:return"DehydratedFragment";case 11:return e=t.render,e=e.displayName||e.name||"",t.displayName||(e!==""?"ForwardRef("+e+")":"ForwardRef");case 7:return"Fragment";case 5:return t;case 4:return"Portal";case 3:return"Root";case 6:return"Text";case 16:return Rl(t);case 8:return t===bu?"StrictMode":"Mode";case 22:return"Offscreen";case 12:return"Profiler";case 21:return"Scope";case 13:return"Suspense";case 19:return"SuspenseList";case 25:return"TracingMarker";case 1:case 0:case 17:case 2:case 14:case 15:if(typeof t==="function")return t.displayName||t.name||null;if(typeof t==="string")return t}return null}function la(e){switch(typeof e){case"boolean":case"number":case"string":case"undefined":return e;case"object":return e;default:return""}}function Yd(e){var t=e.type;return(e=e.nodeName)&&e.toLowerCase()==="input"&&(t==="checkbox"||t==="radio")}function Wm(e){var t=Yd(e)?"checked":"value",a=Object.getOwnPropertyDescriptor(e.constructor.prototype,t),n=""+e[t];if(!e.hasOwnProperty(t)&&typeof a<"u"&&typeof a.get==="function"&&typeof a.set==="function"){var{get:r,set:o}=a;return Object.defineProperty(e,t,{configurable:!0,get:function(){return r.call(this)},set:function(s){n=""+s,o.call(this,s)}}),Object.defineProperty(e,t,{enumerable:a.enumerable}),{getValue:function(){return n},setValue:function(s){n=""+s},stopTracking:function(){e._valueTracker=null,delete e[t]}}}}function Io(e){e._valueTracker||(e._valueTracker=Wm(e))}function Jd(e){if(!e)return!1;var t=e._valueTracker;if(!t)return!0;var a=t.getValue(),n="";return e&&(n=Yd(e)?e.checked?"true":"false":e.value),e=n,e!==a?(t.setValue(e),!0):!1}function $o(e){if(e=e||(typeof document<"u"?document:void 0),typeof e>"u")return null;try{return e.activeElement||e.body}catch(t){return e.body}}function Fl(e,t){var a=t.checked;return le({},t,{defaultChecked:void 0,defaultValue:void 0,value:void 0,checked:a!=null?a:e._wrapperState.initialChecked})}function Ki(e,t){var a=t.defaultValue==null?"":t.defaultValue,n=t.checked!=null?t.checked:t.defaultChecked;a=la(t.value!=null?t.value:a),e._wrapperState={initialChecked:n,initialValue:a,controlled:t.type==="checkbox"||t.type==="radio"?t.checked!=null:t.value!=null}}function ef(e,t){t=t.checked,t!=null&&Su(e,"checked",t,!1)}function Dl(e,t){ef(e,t);var a=la(t.value),n=t.type;if(a!=null)if(n==="number"){if(a===0&&e.value===""||e.value!=a)e.value=""+a}else e.value!==""+a&&(e.value=""+a);else if(n==="submit"||n==="reset"){e.removeAttribute("value");return}t.hasOwnProperty("value")?Bl(e,t.type,a):t.hasOwnProperty("defaultValue")&&Bl(e,t.type,la(t.defaultValue)),t.checked==null&&t.defaultChecked!=null&&(e.defaultChecked=!!t.defaultChecked)}function Xi(e,t,a){if(t.hasOwnProperty("value")||t.hasOwnProperty("defaultValue")){var n=t.type;if(!(n!=="submit"&&n!=="reset"||t.value!==void 0&&t.value!==null))return;t=""+e._wrapperState.initialValue,a||t===e.value||(e.value=t),e.defaultValue=t}a=e.name,a!==""&&(e.name=""),e.defaultChecked=!!e._wrapperState.initialChecked,a!==""&&(e.name=a)}function Bl(e,t,a){if(t!=="number"||$o(e.ownerDocument)!==e)a==null?e.defaultValue=""+e._wrapperState.initialValue:e.defaultValue!==""+a&&(e.defaultValue=""+a)}function ln(e,t,a,n){if(e=e.options,t){t={};for(var r=0;r<a.length;r++)t["$"+a[r]]=!0;for(a=0;a<e.length;a++)r=t.hasOwnProperty("$"+e[a].value),e[a].selected!==r&&(e[a].selected=r),r&&n&&(e[a].defaultSelected=!0)}else{a=""+la(a),t=null;for(r=0;r<e.length;r++){if(e[r].value===a){e[r].selected=!0,n&&(e[r].defaultSelected=!0);return}t!==null||e[r].disabled||(t=e[r])}t!==null&&(t.selected=!0)}}function El(e,t){if(t.dangerouslySetInnerHTML!=null)throw Error(S(91));return le({},t,{value:void 0,defaultValue:void 0,children:""+e._wrapperState.initialValue})}function Zi(e,t){var a=t.value;if(a==null){if(a=t.children,t=t.defaultValue,a!=null){if(t!=null)throw Error(S(92));if(Gn(a)){if(1<a.length)throw Error(S(93));a=a[0]}t=a}t==null&&(t=""),a=t}e._wrapperState={initialValue:la(a)}}function tf(e,t){var a=la(t.value),n=la(t.defaultValue);a!=null&&(a=""+a,a!==e.value&&(e.value=a),t.defaultValue==null&&e.defaultValue!==a&&(e.defaultValue=a)),n!=null&&(e.defaultValue=""+n)}function Qi(e){var t=e.textContent;t===e._wrapperState.initialValue&&t!==""&&t!==null&&(e.value=t)}function af(e){switch(e){case"svg":return"http://www.w3.org/2000/svg";case"math":return"http://www.w3.org/1998/Math/MathML";default:return"http://www.w3.org/1999/xhtml"}}function Nl(e,t){return e==null||e==="http://www.w3.org/1999/xhtml"?af(t):e==="http://www.w3.org/2000/svg"&&t==="foreignObject"?"http://www.w3.org/1999/xhtml":e}function ir(e,t){if(t){var a=e.firstChild;if(a&&a===e.lastChild&&a.nodeType===3){a.nodeValue=t;return}}e.textContent=t}function rf(e,t,a){return t==null||typeof t==="boolean"||t===""?"":a||typeof t!=="number"||t===0||Jn.hasOwnProperty(e)&&Jn[e]?(""+t).trim():t+"px"}function of(e,t){e=e.style;for(var a in t)if(t.hasOwnProperty(a)){var n=a.indexOf("--")===0,r=rf(a,t[a],n);a==="float"&&(a="cssFloat"),n?e.setProperty(a,r):e[a]=r}}function Ol(e,t){if(t){if(Gm[e]&&(t.children!=null||t.dangerouslySetInnerHTML!=null))throw Error(S(137,e));if(t.dangerouslySetInnerHTML!=null){if(t.children!=null)throw Error(S(60));if(typeof t.dangerouslySetInnerHTML!=="object"||!("__html"in t.dangerouslySetInnerHTML))throw Error(S(61))}if(t.style!=null&&typeof t.style!=="object")throw Error(S(62))}}function Ul(e,t){if(e.indexOf("-")===-1)return typeof t.is==="string";switch(e){case"annotation-xml":case"color-profile":case"font-face":case"font-face-src":case"font-face-uri":case"font-face-format":case"font-face-name":case"missing-glyph":return!1;default:return!0}}function _u(e){return e=e.target||e.srcElement||window,e.correspondingUseElement&&(e=e.correspondingUseElement),e.nodeType===3?e.parentNode:e}function Yi(e){if(e=ys(e)){if(typeof ql!=="function")throw Error(S(280));var t=e.stateNode;t&&(t=Uu(t),ql(e.stateNode,e.type,t))}}function jm(e){un?dn?dn.push(e):dn=[e]:un=e}function $m(){if(un){var e=un,t=dn;if(dn=un=null,Yi(e),t)for(e=0;e<t.length;e++)Yi(t[e])}}function sf(e,t){return e(t)}function lf(){}function uf(e,t,a){if(fl)return e(t,a);fl=!0;try{return sf(e,t,a)}finally{if(fl=!1,un!==null||dn!==null)lf(),$m()}}function dr(e,t){var a=e.stateNode;if(a===null)return null;var n=Uu(a);if(n===null)return null;a=n[t];e:switch(t){case"onClick":case"onClickCapture":case"onDoubleClick":case"onDoubleClickCapture":case"onMouseDown":case"onMouseDownCapture":case"onMouseMove":case"onMouseMoveCapture":case"onMouseUp":case"onMouseUpCapture":case"onMouseEnter":(n=!n.disabled)||(e=e.type,n=!(e==="button"||e==="input"||e==="select"||e==="textarea")),e=!n;break e;default:e=!1}if(e)return null;if(a&&typeof a!=="function")throw Error(S(231,t,typeof a));return a}function Km(e,t,a,n,r,o,s,l,u){var c=Array.prototype.slice.call(arguments,3);try{t.apply(a,c)}catch(m){this.onError(m)}}function Zm(e,t,a,n,r,o,s,l,u){er=!1,Ko=null,Km.apply(Xm,arguments)}function Qm(e,t,a,n,r,o,s,l,u){if(Zm.apply(this,arguments),er){if(er){var c=Ko;er=!1,Ko=null}else throw Error(S(198));Xo||(Xo=!0,Vl=c)}}function Fa(e){var t=e,a=e;if(e.alternate)for(;t.return;)t=t.return;else{e=t;do t=e,(t.flags&4098)!==0&&(a=t.return),e=t.return;while(e)}return t.tag===3?a:null}function df(e){if(e.tag===13){var t=e.memoizedState;if(t===null&&(e=e.alternate,e!==null&&(t=e.memoizedState)),t!==null)return t.dehydrated}return null}function Ji(e){if(Fa(e)!==e)throw Error(S(188))}function Ym(e){var t=e.alternate;if(!t){if(t=Fa(e),t===null)throw Error(S(188));return t!==e?null:e}for(var a=e,n=t;;){var r=a.return;if(r===null)break;var o=r.alternate;if(o===null){if(n=r.return,n!==null){a=n;continue}break}if(r.child===o.child){for(o=r.child;o;){if(o===a)return Ji(r),e;if(o===n)return Ji(r),t;o=o.sibling}throw Error(S(188))}if(a.return!==n.return)a=r,n=o;else{for(var s=!1,l=r.child;l;){if(l===a){s=!0,a=r,n=o;break}if(l===n){s=!0,n=r,a=o;break}l=l.sibling}if(!s){for(l=o.child;l;){if(l===a){s=!0,a=o,n=r;break}if(l===n){s=!0,n=o,a=r;break}l=l.sibling}if(!s)throw Error(S(189))}}if(a.alternate!==n)throw Error(S(190))}if(a.tag!==3)throw Error(S(188));return a.stateNode.current===a?e:t}function Jm(e){return e=Ym(e),e!==null?ff(e):null}function ff(e){if(e.tag===5||e.tag===6)return e;for(e=e.child;e!==null;){var t=ff(e);if(t!==null)return t;e=e.sibling}return null}function rh(e){if(_t&&typeof _t.onCommitFiberRoot==="function")try{_t.onCommitFiberRoot(gs,e,void 0,(e.current.flags&128)===128)}catch(t){}}function lh(e){return e>>>=0,e===0?32:31-(oh(e)/sh|0)|0}function jn(e){switch(e&-e){case 1:return 1;case 2:return 2;case 4:return 4;case 8:return 8;case 16:return 16;case 32:return 32;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return e&4194240;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return e&130023424;case 134217728:return 134217728;case 268435456:return 268435456;case 536870912:return 536870912;case 1073741824:return 1073741824;default:return e}}function Qo(e,t){var a=e.pendingLanes;if(a===0)return 0;var n=0,r=e.suspendedLanes,o=e.pingedLanes,s=a&268435455;if(s!==0){var l=s&~r;l!==0?n=jn(l):(o&=s,o!==0&&(n=jn(o)))}else s=a&~r,s!==0?n=jn(s):o!==0&&(n=jn(o));if(n===0)return 0;if(t!==0&&t!==n&&(t&r)===0&&(r=n&-n,o=t&-t,r>=o||r===16&&(o&4194240)!==0))return t;if((n&4)!==0&&(n|=a&16),t=e.entangledLanes,t!==0)for(e=e.entanglements,t&=n;0<t;)a=31-ht(t),r=1<<a,n|=e[a],t&=~r;return n}function uh(e,t){switch(e){case 1:case 2:case 4:return t+250;case 8:case 16:case 32:case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return t+5000;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return-1;case 134217728:case 268435456:case 536870912:case 1073741824:return-1;default:return-1}}function ih(e,t){for(var{suspendedLanes:a,pingedLanes:n,expirationTimes:r,pendingLanes:o}=e;0<o;){var s=31-ht(o),l=1<<s,u=r[s];if(u===-1){if((l&a)===0||(l&n)!==0)r[s]=uh(l,t)}else u<=t&&(e.expiredLanes|=l);o&=~l}}function Gl(e){return e=e.pendingLanes&-1073741825,e!==0?e:e&1073741824?1073741824:0}function hf(){var e=Co;return Co<<=1,(Co&4194240)===0&&(Co=64),e}function cl(e){for(var t=[],a=0;31>a;a++)t.push(e);return t}function Cr(e,t,a){e.pendingLanes|=t,t!==536870912&&(e.suspendedLanes=0,e.pingedLanes=0),e=e.eventTimes,t=31-ht(t),e[t]=a}function dh(e,t){var a=e.pendingLanes&~t;e.pendingLanes=t,e.suspendedLanes=0,e.pingedLanes=0,e.expiredLanes&=t,e.mutableReadLanes&=t,e.entangledLanes&=t,t=e.entanglements;var n=e.eventTimes;for(e=e.expirationTimes;0<a;){var r=31-ht(a),o=1<<r;t[r]=0,n[r]=-1,e[r]=-1,a&=~o}}function zu(e,t){var a=e.entangledLanes|=t;for(e=e.entanglements;a;){var n=31-ht(a),r=1<<n;r&t|e[n]&t&&(e[n]|=t),a&=~r}}function gf(e){return e&=-e,1<e?4<e?(e&268435455)!==0?16:536870912:4:1}function td(e,t){switch(e){case"focusin":case"focusout":Jt=null;break;case"dragenter":case"dragleave":ea=null;break;case"mouseover":case"mouseout":ta=null;break;case"pointerover":case"pointerout":fr.delete(t.pointerId);break;case"gotpointercapture":case"lostpointercapture":cr.delete(t.pointerId)}}function En(e,t,a,n,r,o){if(e===null||e.nativeEvent!==o)return e={blockedOn:t,domEventName:a,eventSystemFlags:n,nativeEvent:o,targetContainers:[r]},t!==null&&(t=ys(t),t!==null&&Tu(t)),e;return e.eventSystemFlags|=n,t=e.targetContainers,r!==null&&t.indexOf(r)===-1&&t.push(r),e}function ch(e,t,a,n,r){switch(t){case"focusin":return Jt=En(Jt,e,t,a,n,r),!0;case"dragenter":return ea=En(ea,e,t,a,n,r),!0;case"mouseover":return ta=En(ta,e,t,a,n,r),!0;case"pointerover":var o=r.pointerId;return fr.set(o,En(fr.get(o)||null,e,t,a,n,r)),!0;case"gotpointercapture":return o=r.pointerId,cr.set(o,En(cr.get(o)||null,e,t,a,n,r)),!0}return!1}function vf(e){var t=Ca(e.target);if(t!==null){var a=Fa(t);if(a!==null){if(t=a.tag,t===13){if(t=df(a),t!==null){e.blockedOn=t,yf(e.priority,function(){wf(a)});return}}else if(t===3&&a.stateNode.current.memoizedState.isDehydrated){e.blockedOn=a.tag===3?a.stateNode.containerInfo:null;return}}}e.blockedOn=null}function Bo(e){if(e.blockedOn!==null)return!1;for(var t=e.targetContainers;0<t.length;){var a=$l(e.domEventName,e.eventSystemFlags,t[0],e.nativeEvent);if(a===null){a=e.nativeEvent;var n=new a.constructor(a.type,a);Hl=n,a.target.dispatchEvent(n),Hl=null}else return t=ys(a),t!==null&&Tu(t),e.blockedOn=a,!1;t.shift()}return!0}function ad(e,t,a){Bo(e)&&a.delete(t)}function ph(){jl=!1,Jt!==null&&Bo(Jt)&&(Jt=null),ea!==null&&Bo(ea)&&(ea=null),ta!==null&&Bo(ta)&&(ta=null),fr.forEach(ad),cr.forEach(ad)}function Nn(e,t){e.blockedOn===t&&(e.blockedOn=null,jl||(jl=!0,re.unstable_scheduleCallback(re.unstable_NormalPriority,ph)))}function pr(e){function t(r){return Nn(r,e)}if(0<bo.length){Nn(bo[0],e);for(var a=1;a<bo.length;a++){var n=bo[a];n.blockedOn===e&&(n.blockedOn=null)}}Jt!==null&&Nn(Jt,e),ea!==null&&Nn(ea,e),ta!==null&&Nn(ta,e),fr.forEach(t),cr.forEach(t);for(a=0;a<Xt.length;a++)n=Xt[a],n.blockedOn===e&&(n.blockedOn=null);for(;0<Xt.length&&(a=Xt[0],a.blockedOn===null);)vf(a),a.blockedOn===null&&Xt.shift()}function mh(e,t,a,n){var r=K,o=fn.transition;fn.transition=null;try{K=1,Ru(e,t,a,n)}finally{K=r,fn.transition=o}}function hh(e,t,a,n){var r=K,o=fn.transition;fn.transition=null;try{K=4,Ru(e,t,a,n)}finally{K=r,fn.transition=o}}function Ru(e,t,a,n){if(Yo){var r=$l(e,t,a,n);if(r===null)wl(e,t,n,Jo,a),td(e,n);else if(ch(r,e,t,a,n))n.stopPropagation();else if(td(e,n),t&4&&-1<fh.indexOf(e)){for(;r!==null;){var o=ys(r);if(o!==null&&xf(o),o=$l(e,t,a,n),o===null&&wl(e,t,n,Jo,a),o===r)break;r=o}r!==null&&n.stopPropagation()}else wl(e,t,n,null,a)}}function $l(e,t,a,n){if(Jo=null,e=_u(n),e=Ca(e),e!==null)if(t=Fa(e),t===null)e=null;else if(a=t.tag,a===13){if(e=df(t),e!==null)return e;e=null}else if(a===3){if(t.stateNode.current.memoizedState.isDehydrated)return t.tag===3?t.stateNode.containerInfo:null;e=null}else t!==e&&(e=null);return Jo=e,null}function If(e){switch(e){case"cancel":case"click":case"close":case"contextmenu":case"copy":case"cut":case"auxclick":case"dblclick":case"dragend":case"dragstart":case"drop":case"focusin":case"focusout":case"input":case"invalid":case"keydown":case"keypress":case"keyup":case"mousedown":case"mouseup":case"paste":case"pause":case"play":case"pointercancel":case"pointerdown":case"pointerup":case"ratechange":case"reset":case"resize":case"seeked":case"submit":case"touchcancel":case"touchend":case"touchstart":case"volumechange":case"change":case"selectionchange":case"textInput":case"compositionstart":case"compositionend":case"compositionupdate":case"beforeblur":case"afterblur":case"beforeinput":case"blur":case"fullscreenchange":case"focus":case"hashchange":case"popstate":case"select":case"selectstart":return 1;case"drag":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"mousemove":case"mouseout":case"mouseover":case"pointermove":case"pointerout":case"pointerover":case"scroll":case"toggle":case"touchmove":case"wheel":case"mouseenter":case"mouseleave":case"pointerenter":case"pointerleave":return 4;case"message":switch(ah()){case Au:return 1;case pf:return 4;case Zo:case nh:return 16;case mf:return 536870912;default:return 16}default:return 16}}function kf(){if(Eo)return Eo;var e,t=Fu,a=t.length,n,r="value"in Qt?Qt.value:Qt.textContent,o=r.length;for(e=0;e<a&&t[e]===r[e];e++);var s=a-e;for(n=1;n<=s&&t[a-n]===r[o-n];n++);return Eo=r.slice(e,1<n?1-n:void 0)}function No(e){var t=e.keyCode;return"charCode"in e?(e=e.charCode,e===0&&t===13&&(e=13)):e=t,e===10&&(e=13),32<=e||e===13?e:0}function Po(){return!0}function nd(){return!1}function Xe(e){function t(a,n,r,o,s){this._reactName=a,this._targetInst=r,this.type=n,this.nativeEvent=o,this.target=s,this.currentTarget=null;for(var l in e)e.hasOwnProperty(l)&&(a=e[l],this[l]=a?a(o):o[l]);return this.isDefaultPrevented=(o.defaultPrevented!=null?o.defaultPrevented:o.returnValue===!1)?Po:nd,this.isPropagationStopped=nd,this}return le(t.prototype,{preventDefault:function(){this.defaultPrevented=!0;var a=this.nativeEvent;a&&(a.preventDefault?a.preventDefault():typeof a.returnValue!=="unknown"&&(a.returnValue=!1),this.isDefaultPrevented=Po)},stopPropagation:function(){var a=this.nativeEvent;a&&(a.stopPropagation?a.stopPropagation():typeof a.cancelBubble!=="unknown"&&(a.cancelBubble=!0),this.isPropagationStopped=Po)},persist:function(){},isPersistent:Po}),t}function Mh(e){var t=this.nativeEvent;return t.getModifierState?t.getModifierState(e):(e=Ph[e])?!!t[e]:!1}function Bu(){return Mh}function Sf(e,t){switch(e){case"keyup":return Nh.indexOf(t.keyCode)!==-1;case"keydown":return t.keyCode!==229;case"keypress":case"mousedown":case"focusout":return!0;default:return!1}}function bf(e){return e=e.detail,typeof e==="object"&&"data"in e?e.data:null}function Uh(e,t){switch(e){case"compositionend":return bf(t);case"keypress":if(t.which!==32)return null;return ud=!0,ld;case"textInput":return e=t.data,e===ld&&ud?null:e;default:return null}}function Hh(e,t){if(Ya)return e==="compositionend"||!Eu&&Sf(e,t)?(e=kf(),Eo=Fu=Qt=null,Ya=!1,e):null;switch(e){case"paste":return null;case"keypress":if(!(t.ctrlKey||t.altKey||t.metaKey)||t.ctrlKey&&t.altKey){if(t.char&&1<t.char.length)return t.char;if(t.which)return String.fromCharCode(t.which)}return null;case"compositionend":return Cf&&t.locale!=="ko"?null:t.data;default:return null}}function id(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t==="input"?!!qh[e.type]:t==="textarea"?!0:!1}function Pf(e,t,a,n){jm(n),t=es(t,"onChange"),0<t.length&&(a=new Du("onChange","change",null,a,n),e.push({event:a,listeners:t}))}function Wh(e){Nf(e,0)}function ws(e){var t=Yn(e);if(Jd(t))return e}function Vh(e,t){if(e==="change")return t}function dd(){ar&&(ar.detachEvent("onpropertychange",_f),mr=ar=null)}function _f(e){if(e.propertyName==="value"&&ws(mr)){var t=[];Pf(t,mr,e,_u(e)),uf(Wh,t)}}function Gh(e,t,a){e==="focusin"?(dd(),ar=t,mr=a,ar.attachEvent("onpropertychange",_f)):e==="focusout"&&dd()}function jh(e){if(e==="selectionchange"||e==="keyup"||e==="keydown")return ws(mr)}function $h(e,t){if(e==="click")return ws(t)}function Kh(e,t){if(e==="input"||e==="change")return ws(t)}function Xh(e,t){return e===t&&(e!==0||1/e===1/t)||e!==e&&t!==t}function hr(e,t){if(xt(e,t))return!0;if(typeof e!=="object"||e===null||typeof t!=="object"||t===null)return!1;var a=Object.keys(e),n=Object.keys(t);if(a.length!==n.length)return!1;for(n=0;n<a.length;n++){var r=a[n];if(!_l.call(t,r)||!xt(e[r],t[r]))return!1}return!0}function fd(e){for(;e&&e.firstChild;)e=e.firstChild;return e}function cd(e,t){var a=fd(e);e=0;for(var n;a;){if(a.nodeType===3){if(n=e+a.textContent.length,e<=t&&n>=t)return{node:a,offset:t-e};e=n}e:{for(;a;){if(a.nextSibling){a=a.nextSibling;break e}a=a.parentNode}a=void 0}a=fd(a)}}function Af(e,t){return e&&t?e===t?!0:e&&e.nodeType===3?!1:t&&t.nodeType===3?Af(e,t.parentNode):("contains"in e)?e.contains(t):e.compareDocumentPosition?!!(e.compareDocumentPosition(t)&16):!1:!1}function zf(){for(var e=window,t=$o();t instanceof e.HTMLIFrameElement;){try{var a=typeof t.contentWindow.location.href==="string"}catch(n){a=!1}if(a)e=t.contentWindow;else break;t=$o(e.document)}return t}function Nu(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t&&(t==="input"&&(e.type==="text"||e.type==="search"||e.type==="tel"||e.type==="url"||e.type==="password")||t==="textarea"||e.contentEditable==="true")}function Zh(e){var t=zf(),a=e.focusedElem,n=e.selectionRange;if(t!==a&&a&&a.ownerDocument&&Af(a.ownerDocument.documentElement,a)){if(n!==null&&Nu(a)){if(t=n.start,e=n.end,e===void 0&&(e=t),"selectionStart"in a)a.selectionStart=t,a.selectionEnd=Math.min(e,a.value.length);else if(e=(t=a.ownerDocument||document)&&t.defaultView||window,e.getSelection){e=e.getSelection();var r=a.textContent.length,o=Math.min(n.start,r);n=n.end===void 0?o:Math.min(n.end,r),!e.extend&&o>n&&(r=n,n=o,o=r),r=cd(a,o);var s=cd(a,n);r&&s&&(e.rangeCount!==1||e.anchorNode!==r.node||e.anchorOffset!==r.offset||e.focusNode!==s.node||e.focusOffset!==s.offset)&&(t=t.createRange(),t.setStart(r.node,r.offset),e.removeAllRanges(),o>n?(e.addRange(t),e.extend(s.node,s.offset)):(t.setEnd(s.node,s.offset),e.addRange(t)))}}t=[];for(e=a;e=e.parentNode;)e.nodeType===1&&t.push({element:e,left:e.scrollLeft,top:e.scrollTop});typeof a.focus==="function"&&a.focus();for(a=0;a<t.length;a++)e=t[a],e.element.scrollLeft=e.left,e.element.scrollTop=e.top}}function pd(e,t,a){var n=a.window===a?a.document:a.nodeType===9?a:a.ownerDocument;Xl||Ja==null||Ja!==$o(n)||(n=Ja,("selectionStart"in n)&&Nu(n)?n={start:n.selectionStart,end:n.selectionEnd}:(n=(n.ownerDocument&&n.ownerDocument.defaultView||window).getSelection(),n={anchorNode:n.anchorNode,anchorOffset:n.anchorOffset,focusNode:n.focusNode,focusOffset:n.focusOffset}),nr&&hr(nr,n)||(nr=n,n=es(Kl,"onSelect"),0<n.length&&(t=new Du("onSelect","select",null,t,a),e.push({event:t,listeners:n}),t.target=Ja)))}function Mo(e,t){var a={};return a[e.toLowerCase()]=t.toLowerCase(),a["Webkit"+e]="webkit"+t,a["Moz"+e]="moz"+t,a}function Ls(e){if(gl[e])return gl[e];if(!en[e])return e;var t=en[e],a;for(a in t)if(t.hasOwnProperty(a)&&a in Tf)return gl[e]=t[a];return e}function ia(e,t){Ef.set(e,t),Ra(t,[e])}function hd(e,t,a){var n=e.type||"unknown-event";e.currentTarget=a,Qm(n,t,void 0,e),e.currentTarget=null}function Nf(e,t){t=(t&4)!==0;for(var a=0;a<e.length;a++){var n=e[a],r=n.event;n=n.listeners;e:{var o=void 0;if(t)for(var s=n.length-1;0<=s;s--){var l=n[s],u=l.instance,c=l.currentTarget;if(l=l.listener,u!==o&&r.isPropagationStopped())break e;hd(r,l,c),o=u}else for(s=0;s<n.length;s++){if(l=n[s],u=l.instance,c=l.currentTarget,l=l.listener,u!==o&&r.isPropagationStopped())break e;hd(r,l,c),o=u}}}if(Xo)throw e=Vl,Xo=!1,Vl=null,e}function te(e,t){var a=t[au];a===void 0&&(a=t[au]=new Set);var n=e+"__bubble";a.has(n)||(Of(t,e,2,!1),a.add(n))}function xl(e,t,a){var n=0;t&&(n|=4),Of(a,e,n,t)}function Ou(e){if(!e[_o]){e[_o]=!0,Kd.forEach(function(a){a!=="selectionchange"&&(Yh.has(a)||xl(a,!1,e),xl(a,!0,e))});var t=e.nodeType===9?e:e.ownerDocument;t===null||t[_o]||(t[_o]=!0,xl("selectionchange",!1,t))}}function Of(e,t,a,n){switch(If(t)){case 1:var r=mh;break;case 4:r=hh;break;default:r=Ru}a=r.bind(null,t,a,e),r=void 0,!Wl||t!=="touchstart"&&t!=="touchmove"&&t!=="wheel"||(r=!0),n?r!==void 0?e.addEventListener(t,a,{capture:!0,passive:r}):e.addEventListener(t,a,!0):r!==void 0?e.addEventListener(t,a,{passive:r}):e.addEventListener(t,a,!1)}function wl(e,t,a,n,r){var o=n;if((t&1)===0&&(t&2)===0&&n!==null)e:for(;;){if(n===null)return;var s=n.tag;if(s===3||s===4){var l=n.stateNode.containerInfo;if(l===r||l.nodeType===8&&l.parentNode===r)break;if(s===4)for(s=n.return;s!==null;){var u=s.tag;if(u===3||u===4){if(u=s.stateNode.containerInfo,u===r||u.nodeType===8&&u.parentNode===r)return}s=s.return}for(;l!==null;){if(s=Ca(l),s===null)return;if(u=s.tag,u===5||u===6){n=o=s;continue e}l=l.parentNode}}n=n.return}uf(function(){var c=o,m=_u(a),g=[];e:{var h=Ef.get(e);if(h!==void 0){var w=Du,x=e;switch(e){case"keypress":if(No(a)===0)break e;case"keydown":case"keyup":w=Ah;break;case"focusin":x="focus",w=hl;break;case"focusout":x="blur",w=hl;break;case"beforeblur":case"afterblur":w=hl;break;case"click":if(a.button===2)break e;case"auxclick":case"dblclick":case"mousedown":case"mousemove":case"mouseup":case"mouseout":case"mouseover":case"contextmenu":w=rd;break;case"drag":case"dragend":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"dragstart":case"drop":w=wh;break;case"touchcancel":case"touchend":case"touchmove":case"touchstart":w=Rh;break;case Rf:case Ff:case Df:w=vh;break;case Bf:w=Dh;break;case"scroll":w=gh;break;case"wheel":w=Eh;break;case"copy":case"cut":case"paste":w=kh;break;case"gotpointercapture":case"lostpointercapture":case"pointercancel":case"pointerdown":case"pointermove":case"pointerout":case"pointerover":case"pointerup":w=sd}var k=(t&4)!==0,B=!k&&e==="scroll",f=k?h!==null?h+"Capture":null:h;k=[];for(var d=c,p;d!==null;){p=d;var L=p.stateNode;if(p.tag===5&&L!==null&&(p=L,f!==null&&(L=dr(d,f),L!=null&&k.push(gr(d,L,p)))),B)break;d=d.return}0<k.length&&(h=new w(h,x,null,a,m),g.push({event:h,listeners:k}))}}if((t&7)===0){e:{if(h=e==="mouseover"||e==="pointerover",w=e==="mouseout"||e==="pointerout",h&&a!==Hl&&(x=a.relatedTarget||a.fromElement)&&(Ca(x)||x[kn]))break e;if(w||h){if(h=m.window===m?m:(h=m.ownerDocument)?h.defaultView||h.parentWindow:window,w){if(x=a.relatedTarget||a.toElement,w=c,x=x?Ca(x):null,x!==null&&(B=Fa(x),x!==B||x.tag!==5&&x.tag!==6))x=null}else w=null,x=c;if(w!==x){if(k=rd,L="onMouseLeave",f="onMouseEnter",d="mouse",e==="pointerout"||e==="pointerover")k=sd,L="onPointerLeave",f="onPointerEnter",d="pointer";if(B=w==null?h:Yn(w),p=x==null?h:Yn(x),h=new k(L,d+"leave",w,a,m),h.target=B,h.relatedTarget=p,L=null,Ca(m)===c&&(k=new k(f,d+"enter",x,a,m),k.target=p,k.relatedTarget=B,L=k),B=L,w&&x)t:{k=w,f=x,d=0;for(p=k;p;p=Xa(p))d++;p=0;for(L=f;L;L=Xa(L))p++;for(;0<d-p;)k=Xa(k),d--;for(;0<p-d;)f=Xa(f),p--;for(;d--;){if(k===f||f!==null&&k===f.alternate)break t;k=Xa(k),f=Xa(f)}k=null}else k=null;w!==null&&gd(g,h,w,k,!1),x!==null&&B!==null&&gd(g,B,x,k,!0)}}}e:{if(h=c?Yn(c):window,w=h.nodeName&&h.nodeName.toLowerCase(),w==="select"||w==="input"&&h.type==="file")var I=Vh;else if(id(h))if(Mf)I=Kh;else{I=jh;var T=Gh}else(w=h.nodeName)&&w.toLowerCase()==="input"&&(h.type==="checkbox"||h.type==="radio")&&(I=$h);if(I&&(I=I(e,c))){Pf(g,I,a,m);break e}T&&T(e,h,c),e==="focusout"&&(T=h._wrapperState)&&T.controlled&&h.type==="number"&&Bl(h,"number",h.value)}switch(T=c?Yn(c):window,e){case"focusin":if(id(T)||T.contentEditable==="true")Ja=T,Kl=c,nr=null;break;case"focusout":nr=Kl=Ja=null;break;case"mousedown":Xl=!0;break;case"contextmenu":case"mouseup":case"dragend":Xl=!1,pd(g,a,m);break;case"selectionchange":if(Qh)break;case"keydown":case"keyup":pd(g,a,m)}var F;if(Eu)e:{switch(e){case"compositionstart":var y="onCompositionStart";break e;case"compositionend":y="onCompositionEnd";break e;case"compositionupdate":y="onCompositionUpdate";break e}y=void 0}else Ya?Sf(e,a)&&(y="onCompositionEnd"):e==="keydown"&&a.keyCode===229&&(y="onCompositionStart");if(y&&(Cf&&a.locale!=="ko"&&(Ya||y!=="onCompositionStart"?y==="onCompositionEnd"&&Ya&&(F=kf()):(Qt=m,Fu=("value"in Qt)?Qt.value:Qt.textContent,Ya=!0)),T=es(c,y),0<T.length&&(y=new od(y,e,null,a,m),g.push({event:y,listeners:T}),F?y.data=F:(F=bf(a),F!==null&&(y.data=F)))),F=Oh?Uh(e,a):Hh(e,a))c=es(c,"onBeforeInput"),0<c.length&&(m=new od("onBeforeInput","beforeinput",null,a,m),g.push({event:m,listeners:c}),m.data=F)}Nf(g,t)})}function gr(e,t,a){return{instance:e,listener:t,currentTarget:a}}function es(e,t){for(var a=t+"Capture",n=[];e!==null;){var r=e,o=r.stateNode;r.tag===5&&o!==null&&(r=o,o=dr(e,a),o!=null&&n.unshift(gr(e,o,r)),o=dr(e,t),o!=null&&n.push(gr(e,o,r))),e=e.return}return n}function Xa(e){if(e===null)return null;do e=e.return;while(e&&e.tag!==5);return e?e:null}function gd(e,t,a,n,r){for(var o=t._reactName,s=[];a!==null&&a!==n;){var l=a,u=l.alternate,c=l.stateNode;if(u!==null&&u===n)break;l.tag===5&&c!==null&&(l=c,r?(u=dr(a,o),u!=null&&s.unshift(gr(a,u,l))):r||(u=dr(a,o),u!=null&&s.push(gr(a,u,l)))),a=a.return}s.length!==0&&e.push({event:t,listeners:s})}function xd(e){return(typeof e==="string"?e:""+e).replace(Jh,`
`).replace(e0,"")}function Ao(e,t,a){if(t=xd(t),xd(e)!==t&&a)throw Error(S(425))}function ts(){}function eu(e,t){return e==="textarea"||e==="noscript"||typeof t.children==="string"||typeof t.children==="number"||typeof t.dangerouslySetInnerHTML==="object"&&t.dangerouslySetInnerHTML!==null&&t.dangerouslySetInnerHTML.__html!=null}function n0(e){setTimeout(function(){throw e})}function Ll(e,t){var a=t,n=0;do{var r=a.nextSibling;if(e.removeChild(a),r&&r.nodeType===8)if(a=r.data,a==="/$"){if(n===0){e.removeChild(r),pr(t);return}n--}else a!=="$"&&a!=="$?"&&a!=="$!"||n++;a=r}while(a);pr(t)}function aa(e){for(;e!=null;e=e.nextSibling){var t=e.nodeType;if(t===1||t===3)break;if(t===8){if(t=e.data,t==="$"||t==="$!"||t==="$?")break;if(t==="/$")return null}}return e}function Ld(e){e=e.previousSibling;for(var t=0;e;){if(e.nodeType===8){var a=e.data;if(a==="$"||a==="$!"||a==="$?"){if(t===0)return e;t--}else a==="/$"&&t++}e=e.previousSibling}return null}function Ca(e){var t=e[Mt];if(t)return t;for(var a=e.parentNode;a;){if(t=a[kn]||a[Mt]){if(a=t.alternate,t.child!==null||a!==null&&a.child!==null)for(e=Ld(e);e!==null;){if(a=e[Mt])return a;e=Ld(e)}return t}e=a,a=e.parentNode}return null}function ys(e){return e=e[Mt]||e[kn],!e||e.tag!==5&&e.tag!==6&&e.tag!==13&&e.tag!==3?null:e}function Yn(e){if(e.tag===5||e.tag===6)return e.stateNode;throw Error(S(33))}function Uu(e){return e[xr]||null}function da(e){return{current:e}}function ae(e){0>tn||(e.current=nu[tn],nu[tn]=null,tn--)}function Y(e,t){tn++,nu[tn]=e.current,e.current=t}function hn(e,t){var a=e.type.contextTypes;if(!a)return ua;var n=e.stateNode;if(n&&n.__reactInternalMemoizedUnmaskedChildContext===t)return n.__reactInternalMemoizedMaskedChildContext;var r={},o;for(o in a)r[o]=t[o];return n&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=t,e.__reactInternalMemoizedMaskedChildContext=r),r}function qe(e){return e=e.childContextTypes,e!==null&&e!==void 0}function as(){ae(He),ae(Re)}function yd(e,t,a){if(Re.current!==ua)throw Error(S(168));Y(Re,t),Y(He,a)}function Uf(e,t,a){var n=e.stateNode;if(t=t.childContextTypes,typeof n.getChildContext!=="function")return a;n=n.getChildContext();for(var r in n)if(!(r in t))throw Error(S(108,qm(e)||"Unknown",r));return le({},a,n)}function ns(e){return e=(e=e.stateNode)&&e.__reactInternalMemoizedMergedChildContext||ua,_a=Re.current,Y(Re,e),Y(He,He.current),!0}function vd(e,t,a){var n=e.stateNode;if(!n)throw Error(S(169));a?(e=Uf(e,t,_a),n.__reactInternalMemoizedMergedChildContext=e,ae(He),ae(Re),Y(Re,e)):ae(He),Y(He,a)}function Hf(e){Et===null?Et=[e]:Et.push(e)}function s0(e){vs=!0,Hf(e)}function fa(){if(!yl&&Et!==null){yl=!0;var e=0,t=K;try{var a=Et;for(K=1;e<a.length;e++){var n=a[e];do n=n(!0);while(n!==null)}Et=null,vs=!1}catch(r){throw Et!==null&&(Et=Et.slice(e+1)),cf(Au,fa),r}finally{K=t,yl=!1}}return null}function Ia(e,t){an[nn++]=os,an[nn++]=rs,rs=e,os=t}function qf(e,t,a){Je[et++]=Nt,Je[et++]=Ot,Je[et++]=Aa,Aa=e;var n=Nt;e=Ot;var r=32-ht(n)-1;n&=~(1<<r),a+=1;var o=32-ht(t)+r;if(30<o){var s=r-r%5;o=(n&(1<<s)-1).toString(32),n>>=s,r-=s,Nt=1<<32-ht(t)+r|a<<r|n,Ot=o+e}else Nt=1<<o|a<<r|n,Ot=e}function Hu(e){e.return!==null&&(Ia(e,1),qf(e,1,0))}function qu(e){for(;e===rs;)rs=an[--nn],an[nn]=null,os=an[--nn],an[nn]=null;for(;e===Aa;)Aa=Je[--et],Je[et]=null,Ot=Je[--et],Je[et]=null,Nt=Je[--et],Je[et]=null}function Wf(e,t){var a=tt(5,null,null,0);a.elementType="DELETED",a.stateNode=t,a.return=e,t=e.deletions,t===null?(e.deletions=[a],e.flags|=16):t.push(a)}function Id(e,t){switch(e.tag){case 5:var a=e.type;return t=t.nodeType!==1||a.toLowerCase()!==t.nodeName.toLowerCase()?null:t,t!==null?(e.stateNode=t,Ke=e,$e=aa(t.firstChild),!0):!1;case 6:return t=e.pendingProps===""||t.nodeType!==3?null:t,t!==null?(e.stateNode=t,Ke=e,$e=null,!0):!1;case 13:return t=t.nodeType!==8?null:t,t!==null?(a=Aa!==null?{id:Nt,overflow:Ot}:null,e.memoizedState={dehydrated:t,treeContext:a,retryLane:1073741824},a=tt(18,null,null,0),a.stateNode=t,a.return=e,e.child=a,Ke=e,$e=null,!0):!1;default:return!1}}function ru(e){return(e.mode&1)!==0&&(e.flags&128)===0}function ou(e){if(ne){var t=$e;if(t){var a=t;if(!Id(e,t)){if(ru(e))throw Error(S(418));t=aa(a.nextSibling);var n=Ke;t&&Id(e,t)?Wf(n,a):(e.flags=e.flags&-4097|2,ne=!1,Ke=e)}}else{if(ru(e))throw Error(S(418));e.flags=e.flags&-4097|2,ne=!1,Ke=e}}}function kd(e){for(e=e.return;e!==null&&e.tag!==5&&e.tag!==3&&e.tag!==13;)e=e.return;Ke=e}function zo(e){if(e!==Ke)return!1;if(!ne)return kd(e),ne=!0,!1;var t;if((t=e.tag!==3)&&!(t=e.tag!==5)&&(t=e.type,t=t!=="head"&&t!=="body"&&!eu(e.type,e.memoizedProps)),t&&(t=$e)){if(ru(e))throw Vf(),Error(S(418));for(;t;)Wf(e,t),t=aa(t.nextSibling)}if(kd(e),e.tag===13){if(e=e.memoizedState,e=e!==null?e.dehydrated:null,!e)throw Error(S(317));e:{e=e.nextSibling;for(t=0;e;){if(e.nodeType===8){var a=e.data;if(a==="/$"){if(t===0){$e=aa(e.nextSibling);break e}t--}else a!=="$"&&a!=="$!"&&a!=="$?"||t++}e=e.nextSibling}$e=null}}else $e=Ke?aa(e.stateNode.nextSibling):null;return!0}function Vf(){for(var e=$e;e;)e=aa(e.nextSibling)}function gn(){$e=Ke=null,ne=!1}function Wu(e){mt===null?mt=[e]:mt.push(e)}function Un(e,t,a){if(e=a.ref,e!==null&&typeof e!=="function"&&typeof e!=="object"){if(a._owner){if(a=a._owner,a){if(a.tag!==1)throw Error(S(309));var n=a.stateNode}if(!n)throw Error(S(147,e));var r=n,o=""+e;if(t!==null&&t.ref!==null&&typeof t.ref==="function"&&t.ref._stringRef===o)return t.ref;return t=function(s){var l=r.refs;s===null?delete l[o]:l[o]=s},t._stringRef=o,t}if(typeof e!=="string")throw Error(S(284));if(!a._owner)throw Error(S(290,e))}return e}function To(e,t){throw e=Object.prototype.toString.call(t),Error(S(31,e==="[object Object]"?"object with keys {"+Object.keys(t).join(", ")+"}":e))}function Cd(e){var t=e._init;return t(e._payload)}function Gf(e){function t(f,d){if(e){var p=f.deletions;p===null?(f.deletions=[d],f.flags|=16):p.push(d)}}function a(f,d){if(!e)return null;for(;d!==null;)t(f,d),d=d.sibling;return null}function n(f,d){for(f=new Map;d!==null;)d.key!==null?f.set(d.key,d):f.set(d.index,d),d=d.sibling;return f}function r(f,d){return f=sa(f,d),f.index=0,f.sibling=null,f}function o(f,d,p){if(f.index=p,!e)return f.flags|=1048576,d;if(p=f.alternate,p!==null)return p=p.index,p<d?(f.flags|=2,d):p;return f.flags|=2,d}function s(f){return e&&f.alternate===null&&(f.flags|=2),f}function l(f,d,p,L){if(d===null||d.tag!==6)return d=Pl(p,f.mode,L),d.return=f,d;return d=r(d,p),d.return=f,d}function u(f,d,p,L){var I=p.type;if(I===Qa)return m(f,d,p.props.children,L,p.key);if(d!==null&&(d.elementType===I||typeof I==="object"&&I!==null&&I.$$typeof===$t&&Cd(I)===d.type))return L=r(d,p.props),L.ref=Un(f,d,p),L.return=f,L;return L=jo(p.type,p.key,p.props,null,f.mode,L),L.ref=Un(f,d,p),L.return=f,L}function c(f,d,p,L){if(d===null||d.tag!==4||d.stateNode.containerInfo!==p.containerInfo||d.stateNode.implementation!==p.implementation)return d=Ml(p,f.mode,L),d.return=f,d;return d=r(d,p.children||[]),d.return=f,d}function m(f,d,p,L,I){if(d===null||d.tag!==7)return d=Ma(p,f.mode,L,I),d.return=f,d;return d=r(d,p),d.return=f,d}function g(f,d,p){if(typeof d==="string"&&d!==""||typeof d==="number")return d=Pl(""+d,f.mode,p),d.return=f,d;if(typeof d==="object"&&d!==null){switch(d.$$typeof){case vo:return p=jo(d.type,d.key,d.props,null,f.mode,p),p.ref=Un(f,null,d),p.return=f,p;case Wn:return d=Ml(d,f.mode,p),d.return=f,d;case $t:var L=d._init;return g(f,L(d._payload),p)}if(Gn(d)||Bn(d))return d=Ma(d,f.mode,p,null),d.return=f,d;To(f,d)}return null}function h(f,d,p,L){var I=d!==null?d.key:null;if(typeof p==="string"&&p!==""||typeof p==="number")return I!==null?null:l(f,d,""+p,L);if(typeof p==="object"&&p!==null){switch(p.$$typeof){case vo:return p.key===I?u(f,d,p,L):null;case Wn:return p.key===I?c(f,d,p,L):null;case $t:return I=p._init,h(f,d,I(p._payload),L)}if(Gn(p)||Bn(p))return I!==null?null:m(f,d,p,L,null);To(f,p)}return null}function w(f,d,p,L,I){if(typeof L==="string"&&L!==""||typeof L==="number")return f=f.get(p)||null,l(d,f,""+L,I);if(typeof L==="object"&&L!==null){switch(L.$$typeof){case vo:return f=f.get(L.key===null?p:L.key)||null,u(d,f,L,I);case Wn:return f=f.get(L.key===null?p:L.key)||null,c(d,f,L,I);case $t:var T=L._init;return w(f,d,p,T(L._payload),I)}if(Gn(L)||Bn(L))return f=f.get(p)||null,m(d,f,L,I,null);To(d,L)}return null}function x(f,d,p,L){for(var I=null,T=null,F=d,y=d=0,Q=null;F!==null&&y<p.length;y++){F.index>y?(Q=F,F=null):Q=F.sibling;var D=h(f,F,p[y],L);if(D===null){F===null&&(F=Q);break}e&&F&&D.alternate===null&&t(f,F),d=o(D,d,y),T===null?I=D:T.sibling=D,T=D,F=Q}if(y===p.length)return a(f,F),ne&&Ia(f,y),I;if(F===null){for(;y<p.length;y++)F=g(f,p[y],L),F!==null&&(d=o(F,d,y),T===null?I=F:T.sibling=F,T=F);return ne&&Ia(f,y),I}for(F=n(f,F);y<p.length;y++)Q=w(F,f,y,p[y],L),Q!==null&&(e&&Q.alternate!==null&&F.delete(Q.key===null?y:Q.key),d=o(Q,d,y),T===null?I=Q:T.sibling=Q,T=Q);return e&&F.forEach(function(V){return t(f,V)}),ne&&Ia(f,y),I}function k(f,d,p,L){var I=Bn(p);if(typeof I!=="function")throw Error(S(150));if(p=I.call(p),p==null)throw Error(S(151));for(var T=I=null,F=d,y=d=0,Q=null,D=p.next();F!==null&&!D.done;y++,D=p.next()){F.index>y?(Q=F,F=null):Q=F.sibling;var V=h(f,F,D.value,L);if(V===null){F===null&&(F=Q);break}e&&F&&V.alternate===null&&t(f,F),d=o(V,d,y),T===null?I=V:T.sibling=V,T=V,F=Q}if(D.done)return a(f,F),ne&&Ia(f,y),I;if(F===null){for(;!D.done;y++,D=p.next())D=g(f,D.value,L),D!==null&&(d=o(D,d,y),T===null?I=D:T.sibling=D,T=D);return ne&&Ia(f,y),I}for(F=n(f,F);!D.done;y++,D=p.next())D=w(F,f,y,D.value,L),D!==null&&(e&&D.alternate!==null&&F.delete(D.key===null?y:D.key),d=o(D,d,y),T===null?I=D:T.sibling=D,T=D);return e&&F.forEach(function(ot){return t(f,ot)}),ne&&Ia(f,y),I}function B(f,d,p,L){if(typeof p==="object"&&p!==null&&p.type===Qa&&p.key===null&&(p=p.props.children),typeof p==="object"&&p!==null){switch(p.$$typeof){case vo:e:{for(var I=p.key,T=d;T!==null;){if(T.key===I){if(I=p.type,I===Qa){if(T.tag===7){a(f,T.sibling),d=r(T,p.props.children),d.return=f,f=d;break e}}else if(T.elementType===I||typeof I==="object"&&I!==null&&I.$$typeof===$t&&Cd(I)===T.type){a(f,T.sibling),d=r(T,p.props),d.ref=Un(f,T,p),d.return=f,f=d;break e}a(f,T);break}else t(f,T);T=T.sibling}p.type===Qa?(d=Ma(p.props.children,f.mode,L,p.key),d.return=f,f=d):(L=jo(p.type,p.key,p.props,null,f.mode,L),L.ref=Un(f,d,p),L.return=f,f=L)}return s(f);case Wn:e:{for(T=p.key;d!==null;){if(d.key===T)if(d.tag===4&&d.stateNode.containerInfo===p.containerInfo&&d.stateNode.implementation===p.implementation){a(f,d.sibling),d=r(d,p.children||[]),d.return=f,f=d;break e}else{a(f,d);break}else t(f,d);d=d.sibling}d=Ml(p,f.mode,L),d.return=f,f=d}return s(f);case $t:return T=p._init,B(f,d,T(p._payload),L)}if(Gn(p))return x(f,d,p,L);if(Bn(p))return k(f,d,p,L);To(f,p)}return typeof p==="string"&&p!==""||typeof p==="number"?(p=""+p,d!==null&&d.tag===6?(a(f,d.sibling),d=r(d,p),d.return=f,f=d):(a(f,d),d=Pl(p,f.mode,L),d.return=f,f=d),s(f)):a(f,d)}return B}function Gu(){Vu=rn=ls=null}function ju(e){var t=ss.current;ae(ss),e._currentValue=t}function su(e,t,a){for(;e!==null;){var n=e.alternate;if((e.childLanes&t)!==t?(e.childLanes|=t,n!==null&&(n.childLanes|=t)):n!==null&&(n.childLanes&t)!==t&&(n.childLanes|=t),e===a)break;e=e.return}}function cn(e,t){ls=e,Vu=rn=null,e=e.dependencies,e!==null&&e.firstContext!==null&&((e.lanes&t)!==0&&(Ue=!0),e.firstContext=null)}function nt(e){var t=e._currentValue;if(Vu!==e)if(e={context:e,memoizedValue:t,next:null},rn===null){if(ls===null)throw Error(S(308));rn=e,ls.dependencies={lanes:0,firstContext:e}}else rn=rn.next=e;return t}function $u(e){Sa===null?Sa=[e]:Sa.push(e)}function $f(e,t,a,n){var r=t.interleaved;return r===null?(a.next=a,$u(t)):(a.next=r.next,r.next=a),t.interleaved=a,qt(e,n)}function qt(e,t){e.lanes|=t;var a=e.alternate;a!==null&&(a.lanes|=t),a=e;for(e=e.return;e!==null;)e.childLanes|=t,a=e.alternate,a!==null&&(a.childLanes|=t),a=e,e=e.return;return a.tag===3?a.stateNode:null}function Ku(e){e.updateQueue={baseState:e.memoizedState,firstBaseUpdate:null,lastBaseUpdate:null,shared:{pending:null,interleaved:null,lanes:0},effects:null}}function Kf(e,t){e=e.updateQueue,t.updateQueue===e&&(t.updateQueue={baseState:e.baseState,firstBaseUpdate:e.firstBaseUpdate,lastBaseUpdate:e.lastBaseUpdate,shared:e.shared,effects:e.effects})}function Ut(e,t){return{eventTime:e,lane:t,tag:0,payload:null,callback:null,next:null}}function na(e,t,a){var n=e.updateQueue;if(n===null)return null;if(n=n.shared,(q&2)!==0){var r=n.pending;return r===null?t.next=t:(t.next=r.next,r.next=t),n.pending=t,qt(e,a)}return r=n.interleaved,r===null?(t.next=t,$u(n)):(t.next=r.next,r.next=t),n.interleaved=t,qt(e,a)}function Uo(e,t,a){if(t=t.updateQueue,t!==null&&(t=t.shared,(a&4194240)!==0)){var n=t.lanes;n&=e.pendingLanes,a|=n,t.lanes=a,zu(e,a)}}function Sd(e,t){var a=e.updateQueue,n=e.alternate;if(n!==null&&(n=n.updateQueue,a===n)){var r=null,o=null;if(a=a.firstBaseUpdate,a!==null){do{var s={eventTime:a.eventTime,lane:a.lane,tag:a.tag,payload:a.payload,callback:a.callback,next:null};o===null?r=o=s:o=o.next=s,a=a.next}while(a!==null);o===null?r=o=t:o=o.next=t}else r=o=t;a={baseState:n.baseState,firstBaseUpdate:r,lastBaseUpdate:o,shared:n.shared,effects:n.effects},e.updateQueue=a;return}e=a.lastBaseUpdate,e===null?a.firstBaseUpdate=t:e.next=t,a.lastBaseUpdate=t}function us(e,t,a,n){var r=e.updateQueue;Kt=!1;var o=r.firstBaseUpdate,s=r.lastBaseUpdate,l=r.shared.pending;if(l!==null){r.shared.pending=null;var u=l,c=u.next;u.next=null,s===null?o=c:s.next=c,s=u;var m=e.alternate;m!==null&&(m=m.updateQueue,l=m.lastBaseUpdate,l!==s&&(l===null?m.firstBaseUpdate=c:l.next=c,m.lastBaseUpdate=u))}if(o!==null){var g=r.baseState;s=0,m=c=u=null,l=o;do{var h=l.lane,w=l.eventTime;if((n&h)===h){m!==null&&(m=m.next={eventTime:w,lane:0,tag:l.tag,payload:l.payload,callback:l.callback,next:null});e:{var x=e,k=l;switch(h=t,w=a,k.tag){case 1:if(x=k.payload,typeof x==="function"){g=x.call(w,g,h);break e}g=x;break e;case 3:x.flags=x.flags&-65537|128;case 0:if(x=k.payload,h=typeof x==="function"?x.call(w,g,h):x,h===null||h===void 0)break e;g=le({},g,h);break e;case 2:Kt=!0}}l.callback!==null&&l.lane!==0&&(e.flags|=64,h=r.effects,h===null?r.effects=[l]:h.push(l))}else w={eventTime:w,lane:h,tag:l.tag,payload:l.payload,callback:l.callback,next:null},m===null?(c=m=w,u=g):m=m.next=w,s|=h;if(l=l.next,l===null)if(l=r.shared.pending,l===null)break;else h=l,l=h.next,h.next=null,r.lastBaseUpdate=h,r.shared.pending=null}while(1);if(m===null&&(u=g),r.baseState=u,r.firstBaseUpdate=c,r.lastBaseUpdate=m,t=r.shared.interleaved,t!==null){r=t;do s|=r.lane,r=r.next;while(r!==t)}else o===null&&(r.shared.lanes=0);Ta|=s,e.lanes=s,e.memoizedState=g}}function bd(e,t,a){if(e=t.effects,t.effects=null,e!==null)for(t=0;t<e.length;t++){var n=e[t],r=n.callback;if(r!==null){if(n.callback=null,n=a,typeof r!=="function")throw Error(S(191,r));r.call(n)}}}function ba(e){if(e===br)throw Error(S(174));return e}function Xu(e,t){switch(Y(Lr,t),Y(wr,e),Y(At,br),e=t.nodeType,e){case 9:case 11:t=(t=t.documentElement)?t.namespaceURI:Nl(null,"");break;default:e=e===8?t.parentNode:t,t=e.namespaceURI||null,e=e.tagName,t=Nl(t,e)}ae(At),Y(At,t)}function wn(){ae(At),ae(wr),ae(Lr)}function Xf(e){ba(Lr.current);var t=ba(At.current),a=Nl(t,e.type);t!==a&&(Y(wr,e),Y(At,a))}function Zu(e){wr.current===e&&(ae(At),ae(wr))}function is(e){for(var t=e;t!==null;){if(t.tag===13){var a=t.memoizedState;if(a!==null&&(a=a.dehydrated,a===null||a.data==="$?"||a.data==="$!"))return t}else if(t.tag===19&&t.memoizedProps.revealOrder!==void 0){if((t.flags&128)!==0)return t}else if(t.child!==null){t.child.return=t,t=t.child;continue}if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return null;t=t.return}t.sibling.return=t.return,t=t.sibling}return null}function Qu(){for(var e=0;e<vl.length;e++)vl[e]._workInProgressVersionPrimary=null;vl.length=0}function Ae(){throw Error(S(321))}function Yu(e,t){if(t===null)return!1;for(var a=0;a<t.length&&a<e.length;a++)if(!xt(e[a],t[a]))return!1;return!0}function Ju(e,t,a,n,r,o){if(za=o,se=t,t.memoizedState=null,t.updateQueue=null,t.lanes=0,Ho.current=e===null||e.memoizedState===null?c0:p0,e=a(n,r),rr){o=0;do{if(rr=!1,yr=0,25<=o)throw Error(S(301));o+=1,ve=xe=null,t.updateQueue=null,Ho.current=m0,e=a(n,r)}while(rr)}if(Ho.current=fs,t=xe!==null&&xe.next!==null,za=0,ve=xe=se=null,ds=!1,t)throw Error(S(300));return e}function ei(){var e=yr!==0;return yr=0,e}function Pt(){var e={memoizedState:null,baseState:null,baseQueue:null,queue:null,next:null};return ve===null?se.memoizedState=ve=e:ve=ve.next=e,ve}function rt(){if(xe===null){var e=se.alternate;e=e!==null?e.memoizedState:null}else e=xe.next;var t=ve===null?se.memoizedState:ve.next;if(t!==null)ve=t,xe=e;else{if(e===null)throw Error(S(310));xe=e,e={memoizedState:xe.memoizedState,baseState:xe.baseState,baseQueue:xe.baseQueue,queue:xe.queue,next:null},ve===null?se.memoizedState=ve=e:ve=ve.next=e}return ve}function vr(e,t){return typeof t==="function"?t(e):t}function kl(e){var t=rt(),a=t.queue;if(a===null)throw Error(S(311));a.lastRenderedReducer=e;var n=xe,r=n.baseQueue,o=a.pending;if(o!==null){if(r!==null){var s=r.next;r.next=o.next,o.next=s}n.baseQueue=r=o,a.pending=null}if(r!==null){o=r.next,n=n.baseState;var l=s=null,u=null,c=o;do{var m=c.lane;if((za&m)===m)u!==null&&(u=u.next={lane:0,action:c.action,hasEagerState:c.hasEagerState,eagerState:c.eagerState,next:null}),n=c.hasEagerState?c.eagerState:e(n,c.action);else{var g={lane:m,action:c.action,hasEagerState:c.hasEagerState,eagerState:c.eagerState,next:null};u===null?(l=u=g,s=n):u=u.next=g,se.lanes|=m,Ta|=m}c=c.next}while(c!==null&&c!==o);u===null?s=n:u.next=l,xt(n,t.memoizedState)||(Ue=!0),t.memoizedState=n,t.baseState=s,t.baseQueue=u,a.lastRenderedState=n}if(e=a.interleaved,e!==null){r=e;do o=r.lane,se.lanes|=o,Ta|=o,r=r.next;while(r!==e)}else r===null&&(a.lanes=0);return[t.memoizedState,a.dispatch]}function Cl(e){var t=rt(),a=t.queue;if(a===null)throw Error(S(311));a.lastRenderedReducer=e;var{dispatch:n,pending:r}=a,o=t.memoizedState;if(r!==null){a.pending=null;var s=r=r.next;do o=e(o,s.action),s=s.next;while(s!==r);xt(o,t.memoizedState)||(Ue=!0),t.memoizedState=o,t.baseQueue===null&&(t.baseState=o),a.lastRenderedState=o}return[o,n]}function Zf(){}function Qf(e,t){var a=se,n=rt(),r=t(),o=!xt(n.memoizedState,r);if(o&&(n.memoizedState=r,Ue=!0),n=n.queue,ti(ec.bind(null,a,n,e),[e]),n.getSnapshot!==t||o||ve!==null&&ve.memoizedState.tag&1){if(a.flags|=2048,Ir(9,Jf.bind(null,a,n,r,t),void 0,null),Ie===null)throw Error(S(349));(za&30)!==0||Yf(a,t,r)}return r}function Yf(e,t,a){e.flags|=16384,e={getSnapshot:t,value:a},t=se.updateQueue,t===null?(t={lastEffect:null,stores:null},se.updateQueue=t,t.stores=[e]):(a=t.stores,a===null?t.stores=[e]:a.push(e))}function Jf(e,t,a,n){t.value=a,t.getSnapshot=n,tc(t)&&ac(e)}function ec(e,t,a){return a(function(){tc(t)&&ac(e)})}function tc(e){var t=e.getSnapshot;e=e.value;try{var a=t();return!xt(e,a)}catch(n){return!0}}function ac(e){var t=qt(e,1);t!==null&&gt(t,e,1,-1)}function Pd(e){var t=Pt();return typeof e==="function"&&(e=e()),t.memoizedState=t.baseState=e,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:vr,lastRenderedState:e},t.queue=e,e=e.dispatch=f0.bind(null,se,e),[t.memoizedState,e]}function Ir(e,t,a,n){return e={tag:e,create:t,destroy:a,deps:n,next:null},t=se.updateQueue,t===null?(t={lastEffect:null,stores:null},se.updateQueue=t,t.lastEffect=e.next=e):(a=t.lastEffect,a===null?t.lastEffect=e.next=e:(n=a.next,a.next=e,e.next=n,t.lastEffect=e)),e}function nc(){return rt().memoizedState}function qo(e,t,a,n){var r=Pt();se.flags|=e,r.memoizedState=Ir(1|t,a,void 0,n===void 0?null:n)}function Is(e,t,a,n){var r=rt();n=n===void 0?null:n;var o=void 0;if(xe!==null){var s=xe.memoizedState;if(o=s.destroy,n!==null&&Yu(n,s.deps)){r.memoizedState=Ir(t,a,o,n);return}}se.flags|=e,r.memoizedState=Ir(1|t,a,o,n)}function Md(e,t){return qo(8390656,8,e,t)}function ti(e,t){return Is(2048,8,e,t)}function rc(e,t){return Is(4,2,e,t)}function oc(e,t){return Is(4,4,e,t)}function sc(e,t){if(typeof t==="function")return e=e(),t(e),function(){t(null)};if(t!==null&&t!==void 0)return e=e(),t.current=e,function(){t.current=null}}function lc(e,t,a){return a=a!==null&&a!==void 0?a.concat([e]):null,Is(4,4,sc.bind(null,t,e),a)}function ai(){}function uc(e,t){var a=rt();t=t===void 0?null:t;var n=a.memoizedState;if(n!==null&&t!==null&&Yu(t,n[1]))return n[0];return a.memoizedState=[e,t],e}function ic(e,t){var a=rt();t=t===void 0?null:t;var n=a.memoizedState;if(n!==null&&t!==null&&Yu(t,n[1]))return n[0];return e=e(),a.memoizedState=[e,t],e}function dc(e,t,a){if((za&21)===0)return e.baseState&&(e.baseState=!1,Ue=!0),e.memoizedState=a;return xt(a,t)||(a=hf(),se.lanes|=a,Ta|=a,e.baseState=!0),t}function i0(e,t){var a=K;K=a!==0&&4>a?a:4,e(!0);var n=Il.transition;Il.transition={};try{e(!1),t()}finally{K=a,Il.transition=n}}function fc(){return rt().memoizedState}function d0(e,t,a){var n=oa(e);if(a={lane:n,action:a,hasEagerState:!1,eagerState:null,next:null},cc(e))pc(t,a);else if(a=$f(e,t,a,n),a!==null){var r=Ee();gt(a,e,n,r),mc(a,t,n)}}function f0(e,t,a){var n=oa(e),r={lane:n,action:a,hasEagerState:!1,eagerState:null,next:null};if(cc(e))pc(t,r);else{var o=e.alternate;if(e.lanes===0&&(o===null||o.lanes===0)&&(o=t.lastRenderedReducer,o!==null))try{var s=t.lastRenderedState,l=o(s,a);if(r.hasEagerState=!0,r.eagerState=l,xt(l,s)){var u=t.interleaved;u===null?(r.next=r,$u(t)):(r.next=u.next,u.next=r),t.interleaved=r;return}}catch(c){}finally{}a=$f(e,t,r,n),a!==null&&(r=Ee(),gt(a,e,n,r),mc(a,t,n))}}function cc(e){var t=e.alternate;return e===se||t!==null&&t===se}function pc(e,t){rr=ds=!0;var a=e.pending;a===null?t.next=t:(t.next=a.next,a.next=t),e.pending=t}function mc(e,t,a){if((a&4194240)!==0){var n=t.lanes;n&=e.pendingLanes,a|=n,t.lanes=a,zu(e,a)}}function ct(e,t){if(e&&e.defaultProps){t=le({},t),e=e.defaultProps;for(var a in e)t[a]===void 0&&(t[a]=e[a]);return t}return t}function lu(e,t,a,n){t=e.memoizedState,a=a(n,t),a=a===null||a===void 0?t:le({},t,a),e.memoizedState=a,e.lanes===0&&(e.updateQueue.baseState=a)}function _d(e,t,a,n,r,o,s){return e=e.stateNode,typeof e.shouldComponentUpdate==="function"?e.shouldComponentUpdate(n,o,s):t.prototype&&t.prototype.isPureReactComponent?!hr(a,n)||!hr(r,o):!0}function hc(e,t,a){var n=!1,r=ua,o=t.contextType;return typeof o==="object"&&o!==null?o=nt(o):(r=qe(t)?_a:Re.current,n=t.contextTypes,o=(n=n!==null&&n!==void 0)?hn(e,r):ua),t=new t(a,o),e.memoizedState=t.state!==null&&t.state!==void 0?t.state:null,t.updater=ks,e.stateNode=t,t._reactInternals=e,n&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=r,e.__reactInternalMemoizedMaskedChildContext=o),t}function Ad(e,t,a,n){e=t.state,typeof t.componentWillReceiveProps==="function"&&t.componentWillReceiveProps(a,n),typeof t.UNSAFE_componentWillReceiveProps==="function"&&t.UNSAFE_componentWillReceiveProps(a,n),t.state!==e&&ks.enqueueReplaceState(t,t.state,null)}function uu(e,t,a,n){var r=e.stateNode;r.props=a,r.state=e.memoizedState,r.refs={},Ku(e);var o=t.contextType;typeof o==="object"&&o!==null?r.context=nt(o):(o=qe(t)?_a:Re.current,r.context=hn(e,o)),r.state=e.memoizedState,o=t.getDerivedStateFromProps,typeof o==="function"&&(lu(e,t,o,a),r.state=e.memoizedState),typeof t.getDerivedStateFromProps==="function"||typeof r.getSnapshotBeforeUpdate==="function"||typeof r.UNSAFE_componentWillMount!=="function"&&typeof r.componentWillMount!=="function"||(t=r.state,typeof r.componentWillMount==="function"&&r.componentWillMount(),typeof r.UNSAFE_componentWillMount==="function"&&r.UNSAFE_componentWillMount(),t!==r.state&&ks.enqueueReplaceState(r,r.state,null),us(e,a,r,n),r.state=e.memoizedState),typeof r.componentDidMount==="function"&&(e.flags|=4194308)}function Ln(e,t){try{var a="",n=t;do a+=Hm(n),n=n.return;while(n);var r=a}catch(o){r=`
Error generating stack: `+o.message+`
`+o.stack}return{value:e,source:t,stack:r,digest:null}}function Sl(e,t,a){return{value:e,source:null,stack:a!=null?a:null,digest:t!=null?t:null}}function iu(e,t){try{console.error(t.value)}catch(a){setTimeout(function(){throw a})}}function gc(e,t,a){a=Ut(-1,a),a.tag=3,a.payload={element:null};var n=t.value;return a.callback=function(){ps||(ps=!0,Lu=n),iu(e,t)},a}function xc(e,t,a){a=Ut(-1,a),a.tag=3;var n=e.type.getDerivedStateFromError;if(typeof n==="function"){var r=t.value;a.payload=function(){return n(r)},a.callback=function(){iu(e,t)}}var o=e.stateNode;return o!==null&&typeof o.componentDidCatch==="function"&&(a.callback=function(){iu(e,t),typeof n!=="function"&&(ra===null?ra=new Set([this]):ra.add(this));var s=t.stack;this.componentDidCatch(t.value,{componentStack:s!==null?s:""})}),a}function zd(e,t,a){var n=e.pingCache;if(n===null){n=e.pingCache=new h0;var r=new Set;n.set(t,r)}else r=n.get(t),r===void 0&&(r=new Set,n.set(t,r));r.has(a)||(r.add(a),e=A0.bind(null,e,t,a),t.then(e,e))}function Td(e){do{var t;if(t=e.tag===13)t=e.memoizedState,t=t!==null?t.dehydrated!==null?!0:!1:!0;if(t)return e;e=e.return}while(e!==null);return null}function Rd(e,t,a,n,r){if((e.mode&1)===0)return e===t?e.flags|=65536:(e.flags|=128,a.flags|=131072,a.flags&=-52805,a.tag===1&&(a.alternate===null?a.tag=17:(t=Ut(-1,1),t.tag=2,na(a,t,1))),a.lanes|=1),e;return e.flags|=65536,e.lanes=r,e}function Be(e,t,a,n){t.child=e===null?jf(t,null,a,n):xn(t,e.child,a,n)}function Fd(e,t,a,n,r){a=a.render;var o=t.ref;if(cn(t,r),n=Ju(e,t,a,n,o,r),a=ei(),e!==null&&!Ue)return t.updateQueue=e.updateQueue,t.flags&=-2053,e.lanes&=~r,Wt(e,t,r);return ne&&a&&Hu(t),t.flags|=1,Be(e,t,n,r),t.child}function Dd(e,t,a,n,r){if(e===null){var o=a.type;if(typeof o==="function"&&!ii(o)&&o.defaultProps===void 0&&a.compare===null&&a.defaultProps===void 0)return t.tag=15,t.type=o,wc(e,t,o,n,r);return e=jo(a.type,null,n,t,t.mode,r),e.ref=t.ref,e.return=t,t.child=e}if(o=e.child,(e.lanes&r)===0){var s=o.memoizedProps;if(a=a.compare,a=a!==null?a:hr,a(s,n)&&e.ref===t.ref)return Wt(e,t,r)}return t.flags|=1,e=sa(o,n),e.ref=t.ref,e.return=t,t.child=e}function wc(e,t,a,n,r){if(e!==null){var o=e.memoizedProps;if(hr(o,n)&&e.ref===t.ref)if(Ue=!1,t.pendingProps=n=o,(e.lanes&r)!==0)(e.flags&131072)!==0&&(Ue=!0);else return t.lanes=e.lanes,Wt(e,t,r)}return du(e,t,a,n,r)}function Lc(e,t,a){var n=t.pendingProps,r=n.children,o=e!==null?e.memoizedState:null;if(n.mode==="hidden")if((t.mode&1)===0)t.memoizedState={baseLanes:0,cachePool:null,transitions:null},Y(sn,je),je|=a;else{if((a&1073741824)===0)return e=o!==null?o.baseLanes|a:a,t.lanes=t.childLanes=1073741824,t.memoizedState={baseLanes:e,cachePool:null,transitions:null},t.updateQueue=null,Y(sn,je),je|=e,null;t.memoizedState={baseLanes:0,cachePool:null,transitions:null},n=o!==null?o.baseLanes:a,Y(sn,je),je|=n}else o!==null?(n=o.baseLanes|a,t.memoizedState=null):n=a,Y(sn,je),je|=n;return Be(e,t,r,a),t.child}function yc(e,t){var a=t.ref;if(e===null&&a!==null||e!==null&&e.ref!==a)t.flags|=512,t.flags|=2097152}function du(e,t,a,n,r){var o=qe(a)?_a:Re.current;if(o=hn(t,o),cn(t,r),a=Ju(e,t,a,n,o,r),n=ei(),e!==null&&!Ue)return t.updateQueue=e.updateQueue,t.flags&=-2053,e.lanes&=~r,Wt(e,t,r);return ne&&n&&Hu(t),t.flags|=1,Be(e,t,a,r),t.child}function Bd(e,t,a,n,r){if(qe(a)){var o=!0;ns(t)}else o=!1;if(cn(t,r),t.stateNode===null)Wo(e,t),hc(t,a,n),uu(t,a,n,r),n=!0;else if(e===null){var{stateNode:s,memoizedProps:l}=t;s.props=l;var u=s.context,c=a.contextType;typeof c==="object"&&c!==null?c=nt(c):(c=qe(a)?_a:Re.current,c=hn(t,c));var m=a.getDerivedStateFromProps,g=typeof m==="function"||typeof s.getSnapshotBeforeUpdate==="function";g||typeof s.UNSAFE_componentWillReceiveProps!=="function"&&typeof s.componentWillReceiveProps!=="function"||(l!==n||u!==c)&&Ad(t,s,n,c),Kt=!1;var h=t.memoizedState;s.state=h,us(t,n,s,r),u=t.memoizedState,l!==n||h!==u||He.current||Kt?(typeof m==="function"&&(lu(t,a,m,n),u=t.memoizedState),(l=Kt||_d(t,a,l,n,h,u,c))?(g||typeof s.UNSAFE_componentWillMount!=="function"&&typeof s.componentWillMount!=="function"||(typeof s.componentWillMount==="function"&&s.componentWillMount(),typeof s.UNSAFE_componentWillMount==="function"&&s.UNSAFE_componentWillMount()),typeof s.componentDidMount==="function"&&(t.flags|=4194308)):(typeof s.componentDidMount==="function"&&(t.flags|=4194308),t.memoizedProps=n,t.memoizedState=u),s.props=n,s.state=u,s.context=c,n=l):(typeof s.componentDidMount==="function"&&(t.flags|=4194308),n=!1)}else{s=t.stateNode,Kf(e,t),l=t.memoizedProps,c=t.type===t.elementType?l:ct(t.type,l),s.props=c,g=t.pendingProps,h=s.context,u=a.contextType,typeof u==="object"&&u!==null?u=nt(u):(u=qe(a)?_a:Re.current,u=hn(t,u));var w=a.getDerivedStateFromProps;(m=typeof w==="function"||typeof s.getSnapshotBeforeUpdate==="function")||typeof s.UNSAFE_componentWillReceiveProps!=="function"&&typeof s.componentWillReceiveProps!=="function"||(l!==g||h!==u)&&Ad(t,s,n,u),Kt=!1,h=t.memoizedState,s.state=h,us(t,n,s,r);var x=t.memoizedState;l!==g||h!==x||He.current||Kt?(typeof w==="function"&&(lu(t,a,w,n),x=t.memoizedState),(c=Kt||_d(t,a,c,n,h,x,u)||!1)?(m||typeof s.UNSAFE_componentWillUpdate!=="function"&&typeof s.componentWillUpdate!=="function"||(typeof s.componentWillUpdate==="function"&&s.componentWillUpdate(n,x,u),typeof s.UNSAFE_componentWillUpdate==="function"&&s.UNSAFE_componentWillUpdate(n,x,u)),typeof s.componentDidUpdate==="function"&&(t.flags|=4),typeof s.getSnapshotBeforeUpdate==="function"&&(t.flags|=1024)):(typeof s.componentDidUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(t.flags|=4),typeof s.getSnapshotBeforeUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(t.flags|=1024),t.memoizedProps=n,t.memoizedState=x),s.props=n,s.state=x,s.context=u,n=c):(typeof s.componentDidUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(t.flags|=4),typeof s.getSnapshotBeforeUpdate!=="function"||l===e.memoizedProps&&h===e.memoizedState||(t.flags|=1024),n=!1)}return fu(e,t,a,n,o,r)}function fu(e,t,a,n,r,o){yc(e,t);var s=(t.flags&128)!==0;if(!n&&!s)return r&&vd(t,a,!1),Wt(e,t,o);n=t.stateNode,g0.current=t;var l=s&&typeof a.getDerivedStateFromError!=="function"?null:n.render();return t.flags|=1,e!==null&&s?(t.child=xn(t,e.child,null,o),t.child=xn(t,null,l,o)):Be(e,t,l,o),t.memoizedState=n.state,r&&vd(t,a,!0),t.child}function vc(e){var t=e.stateNode;t.pendingContext?yd(e,t.pendingContext,t.pendingContext!==t.context):t.context&&yd(e,t.context,!1),Xu(e,t.containerInfo)}function Ed(e,t,a,n,r){return gn(),Wu(r),t.flags|=256,Be(e,t,a,n),t.child}function pu(e){return{baseLanes:e,cachePool:null,transitions:null}}function Ic(e,t,a){var n=t.pendingProps,r=oe.current,o=!1,s=(t.flags&128)!==0,l;if((l=s)||(l=e!==null&&e.memoizedState===null?!1:(r&2)!==0),l)o=!0,t.flags&=-129;else if(e===null||e.memoizedState!==null)r|=1;if(Y(oe,r&1),e===null){if(ou(t),e=t.memoizedState,e!==null&&(e=e.dehydrated,e!==null))return(t.mode&1)===0?t.lanes=1:e.data==="$!"?t.lanes=8:t.lanes=1073741824,null;return s=n.children,e=n.fallback,o?(n=t.mode,o=t.child,s={mode:"hidden",children:s},(n&1)===0&&o!==null?(o.childLanes=0,o.pendingProps=s):o=Ps(s,n,0,null),e=Ma(e,n,a,null),o.return=t,e.return=t,o.sibling=e,t.child=o,t.child.memoizedState=pu(a),t.memoizedState=cu,e):ni(t,s)}if(r=e.memoizedState,r!==null&&(l=r.dehydrated,l!==null))return x0(e,t,s,n,l,r,a);if(o){o=n.fallback,s=t.mode,r=e.child,l=r.sibling;var u={mode:"hidden",children:n.children};return(s&1)===0&&t.child!==r?(n=t.child,n.childLanes=0,n.pendingProps=u,t.deletions=null):(n=sa(r,u),n.subtreeFlags=r.subtreeFlags&14680064),l!==null?o=sa(l,o):(o=Ma(o,s,a,null),o.flags|=2),o.return=t,n.return=t,n.sibling=o,t.child=n,n=o,o=t.child,s=e.child.memoizedState,s=s===null?pu(a):{baseLanes:s.baseLanes|a,cachePool:null,transitions:s.transitions},o.memoizedState=s,o.childLanes=e.childLanes&~a,t.memoizedState=cu,n}return o=e.child,e=o.sibling,n=sa(o,{mode:"visible",children:n.children}),(t.mode&1)===0&&(n.lanes=a),n.return=t,n.sibling=null,e!==null&&(a=t.deletions,a===null?(t.deletions=[e],t.flags|=16):a.push(e)),t.child=n,t.memoizedState=null,n}function ni(e,t){return t=Ps({mode:"visible",children:t},e.mode,0,null),t.return=e,e.child=t}function Ro(e,t,a,n){return n!==null&&Wu(n),xn(t,e.child,null,a),e=ni(t,t.pendingProps.children),e.flags|=2,t.memoizedState=null,e}function x0(e,t,a,n,r,o,s){if(a){if(t.flags&256)return t.flags&=-257,n=Sl(Error(S(422))),Ro(e,t,s,n);if(t.memoizedState!==null)return t.child=e.child,t.flags|=128,null;return o=n.fallback,r=t.mode,n=Ps({mode:"visible",children:n.children},r,0,null),o=Ma(o,r,s,null),o.flags|=2,n.return=t,o.return=t,n.sibling=o,t.child=n,(t.mode&1)!==0&&xn(t,e.child,null,s),t.child.memoizedState=pu(s),t.memoizedState=cu,o}if((t.mode&1)===0)return Ro(e,t,s,null);if(r.data==="$!"){if(n=r.nextSibling&&r.nextSibling.dataset,n)var l=n.dgst;return n=l,o=Error(S(419)),n=Sl(o,n,void 0),Ro(e,t,s,n)}if(l=(s&e.childLanes)!==0,Ue||l){if(n=Ie,n!==null){switch(s&-s){case 4:r=2;break;case 16:r=8;break;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:r=32;break;case 536870912:r=268435456;break;default:r=0}r=(r&(n.suspendedLanes|s))!==0?0:r,r!==0&&r!==o.retryLane&&(o.retryLane=r,qt(e,r),gt(n,e,r,-1))}return ui(),n=Sl(Error(S(421))),Ro(e,t,s,n)}if(r.data==="$?")return t.flags|=128,t.child=e.child,t=z0.bind(null,e),r._reactRetry=t,null;return e=o.treeContext,$e=aa(r.nextSibling),Ke=t,ne=!0,mt=null,e!==null&&(Je[et++]=Nt,Je[et++]=Ot,Je[et++]=Aa,Nt=e.id,Ot=e.overflow,Aa=t),t=ni(t,n.children),t.flags|=4096,t}function Nd(e,t,a){e.lanes|=t;var n=e.alternate;n!==null&&(n.lanes|=t),su(e.return,t,a)}function bl(e,t,a,n,r){var o=e.memoizedState;o===null?e.memoizedState={isBackwards:t,rendering:null,renderingStartTime:0,last:n,tail:a,tailMode:r}:(o.isBackwards=t,o.rendering=null,o.renderingStartTime=0,o.last=n,o.tail=a,o.tailMode=r)}function kc(e,t,a){var n=t.pendingProps,r=n.revealOrder,o=n.tail;if(Be(e,t,n.children,a),n=oe.current,(n&2)!==0)n=n&1|2,t.flags|=128;else{if(e!==null&&(e.flags&128)!==0)e:for(e=t.child;e!==null;){if(e.tag===13)e.memoizedState!==null&&Nd(e,a,t);else if(e.tag===19)Nd(e,a,t);else if(e.child!==null){e.child.return=e,e=e.child;continue}if(e===t)break e;for(;e.sibling===null;){if(e.return===null||e.return===t)break e;e=e.return}e.sibling.return=e.return,e=e.sibling}n&=1}if(Y(oe,n),(t.mode&1)===0)t.memoizedState=null;else switch(r){case"forwards":a=t.child;for(r=null;a!==null;)e=a.alternate,e!==null&&is(e)===null&&(r=a),a=a.sibling;a=r,a===null?(r=t.child,t.child=null):(r=a.sibling,a.sibling=null),bl(t,!1,r,a,o);break;case"backwards":a=null,r=t.child;for(t.child=null;r!==null;){if(e=r.alternate,e!==null&&is(e)===null){t.child=r;break}e=r.sibling,r.sibling=a,a=r,r=e}bl(t,!0,a,null,o);break;case"together":bl(t,!1,null,null,void 0);break;default:t.memoizedState=null}return t.child}function Wo(e,t){(t.mode&1)===0&&e!==null&&(e.alternate=null,t.alternate=null,t.flags|=2)}function Wt(e,t,a){if(e!==null&&(t.dependencies=e.dependencies),Ta|=t.lanes,(a&t.childLanes)===0)return null;if(e!==null&&t.child!==e.child)throw Error(S(153));if(t.child!==null){e=t.child,a=sa(e,e.pendingProps),t.child=a;for(a.return=t;e.sibling!==null;)e=e.sibling,a=a.sibling=sa(e,e.pendingProps),a.return=t;a.sibling=null}return t.child}function w0(e,t,a){switch(t.tag){case 3:vc(t),gn();break;case 5:Xf(t);break;case 1:qe(t.type)&&ns(t);break;case 4:Xu(t,t.stateNode.containerInfo);break;case 10:var n=t.type._context,r=t.memoizedProps.value;Y(ss,n._currentValue),n._currentValue=r;break;case 13:if(n=t.memoizedState,n!==null){if(n.dehydrated!==null)return Y(oe,oe.current&1),t.flags|=128,null;if((a&t.child.childLanes)!==0)return Ic(e,t,a);return Y(oe,oe.current&1),e=Wt(e,t,a),e!==null?e.sibling:null}Y(oe,oe.current&1);break;case 19:if(n=(a&t.childLanes)!==0,(e.flags&128)!==0){if(n)return kc(e,t,a);t.flags|=128}if(r=t.memoizedState,r!==null&&(r.rendering=null,r.tail=null,r.lastEffect=null),Y(oe,oe.current),n)break;else return null;case 22:case 23:return t.lanes=0,Lc(e,t,a)}return Wt(e,t,a)}function Hn(e,t){if(!ne)switch(e.tailMode){case"hidden":t=e.tail;for(var a=null;t!==null;)t.alternate!==null&&(a=t),t=t.sibling;a===null?e.tail=null:a.sibling=null;break;case"collapsed":a=e.tail;for(var n=null;a!==null;)a.alternate!==null&&(n=a),a=a.sibling;n===null?t||e.tail===null?e.tail=null:e.tail.sibling=null:n.sibling=null}}function ze(e){var t=e.alternate!==null&&e.alternate.child===e.child,a=0,n=0;if(t)for(var r=e.child;r!==null;)a|=r.lanes|r.childLanes,n|=r.subtreeFlags&14680064,n|=r.flags&14680064,r.return=e,r=r.sibling;else for(r=e.child;r!==null;)a|=r.lanes|r.childLanes,n|=r.subtreeFlags,n|=r.flags,r.return=e,r=r.sibling;return e.subtreeFlags|=n,e.childLanes=a,t}function L0(e,t,a){var n=t.pendingProps;switch(qu(t),t.tag){case 2:case 16:case 15:case 0:case 11:case 7:case 8:case 12:case 9:case 14:return ze(t),null;case 1:return qe(t.type)&&as(),ze(t),null;case 3:if(n=t.stateNode,wn(),ae(He),ae(Re),Qu(),n.pendingContext&&(n.context=n.pendingContext,n.pendingContext=null),e===null||e.child===null)zo(t)?t.flags|=4:e===null||e.memoizedState.isDehydrated&&(t.flags&256)===0||(t.flags|=1024,mt!==null&&(Iu(mt),mt=null));return mu(e,t),ze(t),null;case 5:Zu(t);var r=ba(Lr.current);if(a=t.type,e!==null&&t.stateNode!=null)Sc(e,t,a,n,r),e.ref!==t.ref&&(t.flags|=512,t.flags|=2097152);else{if(!n){if(t.stateNode===null)throw Error(S(166));return ze(t),null}if(e=ba(At.current),zo(t)){n=t.stateNode,a=t.type;var o=t.memoizedProps;switch(n[Mt]=t,n[xr]=o,e=(t.mode&1)!==0,a){case"dialog":te("cancel",n),te("close",n);break;case"iframe":case"object":case"embed":te("load",n);break;case"video":case"audio":for(r=0;r<Qn.length;r++)te(Qn[r],n);break;case"source":te("error",n);break;case"img":case"image":case"link":te("error",n),te("load",n);break;case"details":te("toggle",n);break;case"input":Ki(n,o),te("invalid",n);break;case"select":n._wrapperState={wasMultiple:!!o.multiple},te("invalid",n);break;case"textarea":Zi(n,o),te("invalid",n)}Ol(a,o),r=null;for(var s in o)if(o.hasOwnProperty(s)){var l=o[s];s==="children"?typeof l==="string"?n.textContent!==l&&(o.suppressHydrationWarning!==!0&&Ao(n.textContent,l,e),r=["children",l]):typeof l==="number"&&n.textContent!==""+l&&(o.suppressHydrationWarning!==!0&&Ao(n.textContent,l,e),r=["children",""+l]):ur.hasOwnProperty(s)&&l!=null&&s==="onScroll"&&te("scroll",n)}switch(a){case"input":Io(n),Xi(n,o,!0);break;case"textarea":Io(n),Qi(n);break;case"select":case"option":break;default:typeof o.onClick==="function"&&(n.onclick=ts)}n=r,t.updateQueue=n,n!==null&&(t.flags|=4)}else{s=r.nodeType===9?r:r.ownerDocument,e==="http://www.w3.org/1999/xhtml"&&(e=af(a)),e==="http://www.w3.org/1999/xhtml"?a==="script"?(e=s.createElement("div"),e.innerHTML="<script></script>",e=e.removeChild(e.firstChild)):typeof n.is==="string"?e=s.createElement(a,{is:n.is}):(e=s.createElement(a),a==="select"&&(s=e,n.multiple?s.multiple=!0:n.size&&(s.size=n.size))):e=s.createElementNS(e,a),e[Mt]=t,e[xr]=n,Cc(e,t,!1,!1),t.stateNode=e;e:{switch(s=Ul(a,n),a){case"dialog":te("cancel",e),te("close",e),r=n;break;case"iframe":case"object":case"embed":te("load",e),r=n;break;case"video":case"audio":for(r=0;r<Qn.length;r++)te(Qn[r],e);r=n;break;case"source":te("error",e),r=n;break;case"img":case"image":case"link":te("error",e),te("load",e),r=n;break;case"details":te("toggle",e),r=n;break;case"input":Ki(e,n),r=Fl(e,n),te("invalid",e);break;case"option":r=n;break;case"select":e._wrapperState={wasMultiple:!!n.multiple},r=le({},n,{value:void 0}),te("invalid",e);break;case"textarea":Zi(e,n),r=El(e,n),te("invalid",e);break;default:r=n}Ol(a,r),l=r;for(o in l)if(l.hasOwnProperty(o)){var u=l[o];o==="style"?of(e,u):o==="dangerouslySetInnerHTML"?(u=u?u.__html:void 0,u!=null&&nf(e,u)):o==="children"?typeof u==="string"?(a!=="textarea"||u!=="")&&ir(e,u):typeof u==="number"&&ir(e,""+u):o!=="suppressContentEditableWarning"&&o!=="suppressHydrationWarning"&&o!=="autoFocus"&&(ur.hasOwnProperty(o)?u!=null&&o==="onScroll"&&te("scroll",e):u!=null&&Su(e,o,u,s))}switch(a){case"input":Io(e),Xi(e,n,!1);break;case"textarea":Io(e),Qi(e);break;case"option":n.value!=null&&e.setAttribute("value",""+la(n.value));break;case"select":e.multiple=!!n.multiple,o=n.value,o!=null?ln(e,!!n.multiple,o,!1):n.defaultValue!=null&&ln(e,!!n.multiple,n.defaultValue,!0);break;default:typeof r.onClick==="function"&&(e.onclick=ts)}switch(a){case"button":case"input":case"select":case"textarea":n=!!n.autoFocus;break e;case"img":n=!0;break e;default:n=!1}}n&&(t.flags|=4)}t.ref!==null&&(t.flags|=512,t.flags|=2097152)}return ze(t),null;case 6:if(e&&t.stateNode!=null)bc(e,t,e.memoizedProps,n);else{if(typeof n!=="string"&&t.stateNode===null)throw Error(S(166));if(a=ba(Lr.current),ba(At.current),zo(t)){if(n=t.stateNode,a=t.memoizedProps,n[Mt]=t,o=n.nodeValue!==a){if(e=Ke,e!==null)switch(e.tag){case 3:Ao(n.nodeValue,a,(e.mode&1)!==0);break;case 5:e.memoizedProps.suppressHydrationWarning!==!0&&Ao(n.nodeValue,a,(e.mode&1)!==0)}}o&&(t.flags|=4)}else n=(a.nodeType===9?a:a.ownerDocument).createTextNode(n),n[Mt]=t,t.stateNode=n}return ze(t),null;case 13:if(ae(oe),n=t.memoizedState,e===null||e.memoizedState!==null&&e.memoizedState.dehydrated!==null){if(ne&&$e!==null&&(t.mode&1)!==0&&(t.flags&128)===0)Vf(),gn(),t.flags|=98560,o=!1;else if(o=zo(t),n!==null&&n.dehydrated!==null){if(e===null){if(!o)throw Error(S(318));if(o=t.memoizedState,o=o!==null?o.dehydrated:null,!o)throw Error(S(317));o[Mt]=t}else gn(),(t.flags&128)===0&&(t.memoizedState=null),t.flags|=4;ze(t),o=!1}else mt!==null&&(Iu(mt),mt=null),o=!0;if(!o)return t.flags&65536?t:null}if((t.flags&128)!==0)return t.lanes=a,t;return n=n!==null,n!==(e!==null&&e.memoizedState!==null)&&n&&(t.child.flags|=8192,(t.mode&1)!==0&&(e===null||(oe.current&1)!==0?we===0&&(we=3):ui())),t.updateQueue!==null&&(t.flags|=4),ze(t),null;case 4:return wn(),mu(e,t),e===null&&Ou(t.stateNode.containerInfo),ze(t),null;case 10:return ju(t.type._context),ze(t),null;case 17:return qe(t.type)&&as(),ze(t),null;case 19:if(ae(oe),o=t.memoizedState,o===null)return ze(t),null;if(n=(t.flags&128)!==0,s=o.rendering,s===null)if(n)Hn(o,!1);else{if(we!==0||e!==null&&(e.flags&128)!==0)for(e=t.child;e!==null;){if(s=is(e),s!==null){t.flags|=128,Hn(o,!1),n=s.updateQueue,n!==null&&(t.updateQueue=n,t.flags|=4),t.subtreeFlags=0,n=a;for(a=t.child;a!==null;)o=a,e=n,o.flags&=14680066,s=o.alternate,s===null?(o.childLanes=0,o.lanes=e,o.child=null,o.subtreeFlags=0,o.memoizedProps=null,o.memoizedState=null,o.updateQueue=null,o.dependencies=null,o.stateNode=null):(o.childLanes=s.childLanes,o.lanes=s.lanes,o.child=s.child,o.subtreeFlags=0,o.deletions=null,o.memoizedProps=s.memoizedProps,o.memoizedState=s.memoizedState,o.updateQueue=s.updateQueue,o.type=s.type,e=s.dependencies,o.dependencies=e===null?null:{lanes:e.lanes,firstContext:e.firstContext}),a=a.sibling;return Y(oe,oe.current&1|2),t.child}e=e.sibling}o.tail!==null&&me()>yn&&(t.flags|=128,n=!0,Hn(o,!1),t.lanes=4194304)}else{if(!n)if(e=is(s),e!==null){if(t.flags|=128,n=!0,a=e.updateQueue,a!==null&&(t.updateQueue=a,t.flags|=4),Hn(o,!0),o.tail===null&&o.tailMode==="hidden"&&!s.alternate&&!ne)return ze(t),null}else 2*me()-o.renderingStartTime>yn&&a!==1073741824&&(t.flags|=128,n=!0,Hn(o,!1),t.lanes=4194304);o.isBackwards?(s.sibling=t.child,t.child=s):(a=o.last,a!==null?a.sibling=s:t.child=s,o.last=s)}if(o.tail!==null)return t=o.tail,o.rendering=t,o.tail=t.sibling,o.renderingStartTime=me(),t.sibling=null,a=oe.current,Y(oe,n?a&1|2:a&1),t;return ze(t),null;case 22:case 23:return li(),n=t.memoizedState!==null,e!==null&&e.memoizedState!==null!==n&&(t.flags|=8192),n&&(t.mode&1)!==0?(je&1073741824)!==0&&(ze(t),t.subtreeFlags&6&&(t.flags|=8192)):ze(t),null;case 24:return null;case 25:return null}throw Error(S(156,t.tag))}function y0(e,t){switch(qu(t),t.tag){case 1:return qe(t.type)&&as(),e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 3:return wn(),ae(He),ae(Re),Qu(),e=t.flags,(e&65536)!==0&&(e&128)===0?(t.flags=e&-65537|128,t):null;case 5:return Zu(t),null;case 13:if(ae(oe),e=t.memoizedState,e!==null&&e.dehydrated!==null){if(t.alternate===null)throw Error(S(340));gn()}return e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 19:return ae(oe),null;case 4:return wn(),null;case 10:return ju(t.type._context),null;case 22:case 23:return li(),null;case 24:return null;default:return null}}function on(e,t){var a=e.ref;if(a!==null)if(typeof a==="function")try{a(null)}catch(n){de(e,t,n)}else a.current=null}function hu(e,t,a){try{a()}catch(n){de(e,t,n)}}function I0(e,t){if(Yl=Yo,e=zf(),Nu(e)){if("selectionStart"in e)var a={start:e.selectionStart,end:e.selectionEnd};else e:{a=(a=e.ownerDocument)&&a.defaultView||window;var n=a.getSelection&&a.getSelection();if(n&&n.rangeCount!==0){a=n.anchorNode;var r=n.anchorOffset,o=n.focusNode;n=n.focusOffset;try{a.nodeType,o.nodeType}catch(L){a=null;break e}var s=0,l=-1,u=-1,c=0,m=0,g=e,h=null;t:for(;;){for(var w;;){if(g!==a||r!==0&&g.nodeType!==3||(l=s+r),g!==o||n!==0&&g.nodeType!==3||(u=s+n),g.nodeType===3&&(s+=g.nodeValue.length),(w=g.firstChild)===null)break;h=g,g=w}for(;;){if(g===e)break t;if(h===a&&++c===r&&(l=s),h===o&&++m===n&&(u=s),(w=g.nextSibling)!==null)break;g=h,h=g.parentNode}g=w}a=l===-1||u===-1?null:{start:l,end:u}}else a=null}a=a||{start:0,end:0}}else a=null;Jl={focusedElem:e,selectionRange:a},Yo=!1;for(R=t;R!==null;)if(t=R,e=t.child,(t.subtreeFlags&1028)!==0&&e!==null)e.return=t,R=e;else for(;R!==null;){t=R;try{var x=t.alternate;if((t.flags&1024)!==0)switch(t.tag){case 0:case 11:case 15:break;case 1:if(x!==null){var k=x.memoizedProps,B=x.memoizedState,f=t.stateNode,d=f.getSnapshotBeforeUpdate(t.elementType===t.type?k:ct(t.type,k),B);f.__reactInternalSnapshotBeforeUpdate=d}break;case 3:var p=t.stateNode.containerInfo;p.nodeType===1?p.textContent="":p.nodeType===9&&p.documentElement&&p.removeChild(p.documentElement);break;case 5:case 6:case 4:case 17:break;default:throw Error(S(163))}}catch(L){de(t,t.return,L)}if(e=t.sibling,e!==null){e.return=t.return,R=e;break}R=t.return}return x=Od,Od=!1,x}function or(e,t,a){var n=t.updateQueue;if(n=n!==null?n.lastEffect:null,n!==null){var r=n=n.next;do{if((r.tag&e)===e){var o=r.destroy;r.destroy=void 0,o!==void 0&&hu(t,a,o)}r=r.next}while(r!==n)}}function Cs(e,t){if(t=t.updateQueue,t=t!==null?t.lastEffect:null,t!==null){var a=t=t.next;do{if((a.tag&e)===e){var n=a.create;a.destroy=n()}a=a.next}while(a!==t)}}function gu(e){var t=e.ref;if(t!==null){var a=e.stateNode;switch(e.tag){case 5:e=a;break;default:e=a}typeof t==="function"?t(e):t.current=e}}function Pc(e){var t=e.alternate;t!==null&&(e.alternate=null,Pc(t)),e.child=null,e.deletions=null,e.sibling=null,e.tag===5&&(t=e.stateNode,t!==null&&(delete t[Mt],delete t[xr],delete t[au],delete t[r0],delete t[o0])),e.stateNode=null,e.return=null,e.dependencies=null,e.memoizedProps=null,e.memoizedState=null,e.pendingProps=null,e.stateNode=null,e.updateQueue=null}function Mc(e){return e.tag===5||e.tag===3||e.tag===4}function Ud(e){e:for(;;){for(;e.sibling===null;){if(e.return===null||Mc(e.return))return null;e=e.return}e.sibling.return=e.return;for(e=e.sibling;e.tag!==5&&e.tag!==6&&e.tag!==18;){if(e.flags&2)continue e;if(e.child===null||e.tag===4)continue e;else e.child.return=e,e=e.child}if(!(e.flags&2))return e.stateNode}}function xu(e,t,a){var n=e.tag;if(n===5||n===6)e=e.stateNode,t?a.nodeType===8?a.parentNode.insertBefore(e,t):a.insertBefore(e,t):(a.nodeType===8?(t=a.parentNode,t.insertBefore(e,a)):(t=a,t.appendChild(e)),a=a._reactRootContainer,a!==null&&a!==void 0||t.onclick!==null||(t.onclick=ts));else if(n!==4&&(e=e.child,e!==null))for(xu(e,t,a),e=e.sibling;e!==null;)xu(e,t,a),e=e.sibling}function wu(e,t,a){var n=e.tag;if(n===5||n===6)e=e.stateNode,t?a.insertBefore(e,t):a.appendChild(e);else if(n!==4&&(e=e.child,e!==null))for(wu(e,t,a),e=e.sibling;e!==null;)wu(e,t,a),e=e.sibling}function jt(e,t,a){for(a=a.child;a!==null;)_c(e,t,a),a=a.sibling}function _c(e,t,a){if(_t&&typeof _t.onCommitFiberUnmount==="function")try{_t.onCommitFiberUnmount(gs,a)}catch(l){}switch(a.tag){case 5:Te||on(a,t);case 6:var n=be,r=pt;be=null,jt(e,t,a),be=n,pt=r,be!==null&&(pt?(e=be,a=a.stateNode,e.nodeType===8?e.parentNode.removeChild(a):e.removeChild(a)):be.removeChild(a.stateNode));break;case 18:be!==null&&(pt?(e=be,a=a.stateNode,e.nodeType===8?Ll(e.parentNode,a):e.nodeType===1&&Ll(e,a),pr(e)):Ll(be,a.stateNode));break;case 4:n=be,r=pt,be=a.stateNode.containerInfo,pt=!0,jt(e,t,a),be=n,pt=r;break;case 0:case 11:case 14:case 15:if(!Te&&(n=a.updateQueue,n!==null&&(n=n.lastEffect,n!==null))){r=n=n.next;do{var o=r,s=o.destroy;o=o.tag,s!==void 0&&((o&2)!==0?hu(a,t,s):(o&4)!==0&&hu(a,t,s)),r=r.next}while(r!==n)}jt(e,t,a);break;case 1:if(!Te&&(on(a,t),n=a.stateNode,typeof n.componentWillUnmount==="function"))try{n.props=a.memoizedProps,n.state=a.memoizedState,n.componentWillUnmount()}catch(l){de(a,t,l)}jt(e,t,a);break;case 21:jt(e,t,a);break;case 22:a.mode&1?(Te=(n=Te)||a.memoizedState!==null,jt(e,t,a),Te=n):jt(e,t,a);break;default:jt(e,t,a)}}function Hd(e){var t=e.updateQueue;if(t!==null){e.updateQueue=null;var a=e.stateNode;a===null&&(a=e.stateNode=new v0),t.forEach(function(n){var r=T0.bind(null,e,n);a.has(n)||(a.add(n),n.then(r,r))})}}function ft(e,t){var a=t.deletions;if(a!==null)for(var n=0;n<a.length;n++){var r=a[n];try{var o=e,s=t,l=s;e:for(;l!==null;){switch(l.tag){case 5:be=l.stateNode,pt=!1;break e;case 3:be=l.stateNode.containerInfo,pt=!0;break e;case 4:be=l.stateNode.containerInfo,pt=!0;break e}l=l.return}if(be===null)throw Error(S(160));_c(o,s,r),be=null,pt=!1;var u=r.alternate;u!==null&&(u.return=null),r.return=null}catch(c){de(r,t,c)}}if(t.subtreeFlags&12854)for(t=t.child;t!==null;)Ac(t,e),t=t.sibling}function Ac(e,t){var{alternate:a,flags:n}=e;switch(e.tag){case 0:case 11:case 14:case 15:if(ft(t,e),bt(e),n&4){try{or(3,e,e.return),Cs(3,e)}catch(k){de(e,e.return,k)}try{or(5,e,e.return)}catch(k){de(e,e.return,k)}}break;case 1:ft(t,e),bt(e),n&512&&a!==null&&on(a,a.return);break;case 5:if(ft(t,e),bt(e),n&512&&a!==null&&on(a,a.return),e.flags&32){var r=e.stateNode;try{ir(r,"")}catch(k){de(e,e.return,k)}}if(n&4&&(r=e.stateNode,r!=null)){var o=e.memoizedProps,s=a!==null?a.memoizedProps:o,{type:l,updateQueue:u}=e;if(e.updateQueue=null,u!==null)try{l==="input"&&o.type==="radio"&&o.name!=null&&ef(r,o),Ul(l,s);var c=Ul(l,o);for(s=0;s<u.length;s+=2){var m=u[s],g=u[s+1];m==="style"?of(r,g):m==="dangerouslySetInnerHTML"?nf(r,g):m==="children"?ir(r,g):Su(r,m,g,c)}switch(l){case"input":Dl(r,o);break;case"textarea":tf(r,o);break;case"select":var h=r._wrapperState.wasMultiple;r._wrapperState.wasMultiple=!!o.multiple;var w=o.value;w!=null?ln(r,!!o.multiple,w,!1):h!==!!o.multiple&&(o.defaultValue!=null?ln(r,!!o.multiple,o.defaultValue,!0):ln(r,!!o.multiple,o.multiple?[]:"",!1))}r[xr]=o}catch(k){de(e,e.return,k)}}break;case 6:if(ft(t,e),bt(e),n&4){if(e.stateNode===null)throw Error(S(162));r=e.stateNode,o=e.memoizedProps;try{r.nodeValue=o}catch(k){de(e,e.return,k)}}break;case 3:if(ft(t,e),bt(e),n&4&&a!==null&&a.memoizedState.isDehydrated)try{pr(t.containerInfo)}catch(k){de(e,e.return,k)}break;case 4:ft(t,e),bt(e);break;case 13:ft(t,e),bt(e),r=e.child,r.flags&8192&&(o=r.memoizedState!==null,r.stateNode.isHidden=o,!o||r.alternate!==null&&r.alternate.memoizedState!==null||(si=me())),n&4&&Hd(e);break;case 22:if(m=a!==null&&a.memoizedState!==null,e.mode&1?(Te=(c=Te)||m,ft(t,e),Te=c):ft(t,e),bt(e),n&8192){if(c=e.memoizedState!==null,(e.stateNode.isHidden=c)&&!m&&(e.mode&1)!==0)for(R=e,m=e.child;m!==null;){for(g=R=m;R!==null;){switch(h=R,w=h.child,h.tag){case 0:case 11:case 14:case 15:or(4,h,h.return);break;case 1:on(h,h.return);var x=h.stateNode;if(typeof x.componentWillUnmount==="function"){n=h,a=h.return;try{t=n,x.props=t.memoizedProps,x.state=t.memoizedState,x.componentWillUnmount()}catch(k){de(n,a,k)}}break;case 5:on(h,h.return);break;case 22:if(h.memoizedState!==null){Wd(g);continue}}w!==null?(w.return=h,R=w):Wd(g)}m=m.sibling}e:for(m=null,g=e;;){if(g.tag===5){if(m===null){m=g;try{r=g.stateNode,c?(o=r.style,typeof o.setProperty==="function"?o.setProperty("display","none","important"):o.display="none"):(l=g.stateNode,u=g.memoizedProps.style,s=u!==void 0&&u!==null&&u.hasOwnProperty("display")?u.display:null,l.style.display=rf("display",s))}catch(k){de(e,e.return,k)}}}else if(g.tag===6){if(m===null)try{g.stateNode.nodeValue=c?"":g.memoizedProps}catch(k){de(e,e.return,k)}}else if((g.tag!==22&&g.tag!==23||g.memoizedState===null||g===e)&&g.child!==null){g.child.return=g,g=g.child;continue}if(g===e)break e;for(;g.sibling===null;){if(g.return===null||g.return===e)break e;m===g&&(m=null),g=g.return}m===g&&(m=null),g.sibling.return=g.return,g=g.sibling}}break;case 19:ft(t,e),bt(e),n&4&&Hd(e);break;case 21:break;default:ft(t,e),bt(e)}}function bt(e){var t=e.flags;if(t&2){try{e:{for(var a=e.return;a!==null;){if(Mc(a)){var n=a;break e}a=a.return}throw Error(S(160))}switch(n.tag){case 5:var r=n.stateNode;n.flags&32&&(ir(r,""),n.flags&=-33);var o=Ud(e);wu(e,o,r);break;case 3:case 4:var s=n.stateNode.containerInfo,l=Ud(e);xu(e,l,s);break;default:throw Error(S(161))}}catch(u){de(e,e.return,u)}e.flags&=-3}t&4096&&(e.flags&=-4097)}function k0(e,t,a){R=e,zc(e,t,a)}function zc(e,t,a){for(var n=(e.mode&1)!==0;R!==null;){var r=R,o=r.child;if(r.tag===22&&n){var s=r.memoizedState!==null||Fo;if(!s){var l=r.alternate,u=l!==null&&l.memoizedState!==null||Te;l=Fo;var c=Te;if(Fo=s,(Te=u)&&!c)for(R=r;R!==null;)s=R,u=s.child,s.tag===22&&s.memoizedState!==null?Vd(r):u!==null?(u.return=s,R=u):Vd(r);for(;o!==null;)R=o,zc(o,t,a),o=o.sibling;R=r,Fo=l,Te=c}qd(e,t,a)}else(r.subtreeFlags&8772)!==0&&o!==null?(o.return=r,R=o):qd(e,t,a)}}function qd(e){for(;R!==null;){var t=R;if((t.flags&8772)!==0){var a=t.alternate;try{if((t.flags&8772)!==0)switch(t.tag){case 0:case 11:case 15:Te||Cs(5,t);break;case 1:var n=t.stateNode;if(t.flags&4&&!Te)if(a===null)n.componentDidMount();else{var r=t.elementType===t.type?a.memoizedProps:ct(t.type,a.memoizedProps);n.componentDidUpdate(r,a.memoizedState,n.__reactInternalSnapshotBeforeUpdate)}var o=t.updateQueue;o!==null&&bd(t,o,n);break;case 3:var s=t.updateQueue;if(s!==null){if(a=null,t.child!==null)switch(t.child.tag){case 5:a=t.child.stateNode;break;case 1:a=t.child.stateNode}bd(t,s,a)}break;case 5:var l=t.stateNode;if(a===null&&t.flags&4){a=l;var u=t.memoizedProps;switch(t.type){case"button":case"input":case"select":case"textarea":u.autoFocus&&a.focus();break;case"img":u.src&&(a.src=u.src)}}break;case 6:break;case 4:break;case 12:break;case 13:if(t.memoizedState===null){var c=t.alternate;if(c!==null){var m=c.memoizedState;if(m!==null){var g=m.dehydrated;g!==null&&pr(g)}}}break;case 19:case 17:case 21:case 22:case 23:case 25:break;default:throw Error(S(163))}Te||t.flags&512&&gu(t)}catch(h){de(t,t.return,h)}}if(t===e){R=null;break}if(a=t.sibling,a!==null){a.return=t.return,R=a;break}R=t.return}}function Wd(e){for(;R!==null;){var t=R;if(t===e){R=null;break}var a=t.sibling;if(a!==null){a.return=t.return,R=a;break}R=t.return}}function Vd(e){for(;R!==null;){var t=R;try{switch(t.tag){case 0:case 11:case 15:var a=t.return;try{Cs(4,t)}catch(u){de(t,a,u)}break;case 1:var n=t.stateNode;if(typeof n.componentDidMount==="function"){var r=t.return;try{n.componentDidMount()}catch(u){de(t,r,u)}}var o=t.return;try{gu(t)}catch(u){de(t,o,u)}break;case 5:var s=t.return;try{gu(t)}catch(u){de(t,s,u)}}}catch(u){de(t,t.return,u)}if(t===e){R=null;break}var l=t.sibling;if(l!==null){l.return=t.return,R=l;break}R=t.return}}function Ee(){return(q&6)!==0?me():Vo!==-1?Vo:Vo=me()}function oa(e){if((e.mode&1)===0)return 1;if((q&2)!==0&&Pe!==0)return Pe&-Pe;if(l0.transition!==null)return Go===0&&(Go=hf()),Go;if(e=K,e!==0)return e;return e=window.event,e=e===void 0?16:If(e.type),e}function gt(e,t,a,n){if(50<lr)throw lr=0,yu=null,Error(S(185));if(Cr(e,a,n),(q&2)===0||e!==Ie)e===Ie&&((q&2)===0&&(Ss|=a),we===4&&Zt(e,Pe)),We(e,n),a===1&&q===0&&(t.mode&1)===0&&(yn=me()+500,vs&&fa())}function We(e,t){var a=e.callbackNode;ih(e,t);var n=Qo(e,e===Ie?Pe:0);if(n===0)a!==null&&ed(a),e.callbackNode=null,e.callbackPriority=0;else if(t=n&-n,e.callbackPriority!==t){if(a!=null&&ed(a),t===1)e.tag===0?s0(Gd.bind(null,e)):Hf(Gd.bind(null,e)),a0(function(){(q&6)===0&&fa()}),a=null;else{switch(gf(n)){case 1:a=Au;break;case 4:a=pf;break;case 16:a=Zo;break;case 536870912:a=mf;break;default:a=Zo}a=Oc(a,Tc.bind(null,e))}e.callbackPriority=t,e.callbackNode=a}}function Tc(e,t){if(Vo=-1,Go=0,(q&6)!==0)throw Error(S(327));var a=e.callbackNode;if(pn()&&e.callbackNode!==a)return null;var n=Qo(e,e===Ie?Pe:0);if(n===0)return null;if((n&30)!==0||(n&e.expiredLanes)!==0||t)t=hs(e,n);else{t=n;var r=q;q|=2;var o=Fc();if(Ie!==e||Pe!==t)Bt=null,yn=me()+500,Pa(e,t);do try{M0();break}catch(l){Rc(e,l)}while(1);Gu(),cs.current=o,q=r,ge!==null?t=0:(Ie=null,Pe=0,t=we)}if(t!==0){if(t===2&&(r=Gl(e),r!==0&&(n=r,t=vu(e,r))),t===1)throw a=kr,Pa(e,0),Zt(e,n),We(e,me()),a;if(t===6)Zt(e,n);else{if(r=e.current.alternate,(n&30)===0&&!S0(r)&&(t=hs(e,n),t===2&&(o=Gl(e),o!==0&&(n=o,t=vu(e,o))),t===1))throw a=kr,Pa(e,0),Zt(e,n),We(e,me()),a;switch(e.finishedWork=r,e.finishedLanes=n,t){case 0:case 1:throw Error(S(345));case 2:ka(e,Oe,Bt);break;case 3:if(Zt(e,n),(n&130023424)===n&&(t=si+500-me(),10<t)){if(Qo(e,0)!==0)break;if(r=e.suspendedLanes,(r&n)!==n){Ee(),e.pingedLanes|=e.suspendedLanes&r;break}e.timeoutHandle=tu(ka.bind(null,e,Oe,Bt),t);break}ka(e,Oe,Bt);break;case 4:if(Zt(e,n),(n&4194240)===n)break;t=e.eventTimes;for(r=-1;0<n;){var s=31-ht(n);o=1<<s,s=t[s],s>r&&(r=s),n&=~o}if(n=r,n=me()-n,n=(120>n?120:480>n?480:1080>n?1080:1920>n?1920:3000>n?3000:4320>n?4320:1960*C0(n/1960))-n,10<n){e.timeoutHandle=tu(ka.bind(null,e,Oe,Bt),n);break}ka(e,Oe,Bt);break;case 5:ka(e,Oe,Bt);break;default:throw Error(S(329))}}}return We(e,me()),e.callbackNode===a?Tc.bind(null,e):null}function vu(e,t){var a=sr;return e.current.memoizedState.isDehydrated&&(Pa(e,t).flags|=256),e=hs(e,t),e!==2&&(t=Oe,Oe=a,t!==null&&Iu(t)),e}function Iu(e){Oe===null?Oe=e:Oe.push.apply(Oe,e)}function S0(e){for(var t=e;;){if(t.flags&16384){var a=t.updateQueue;if(a!==null&&(a=a.stores,a!==null))for(var n=0;n<a.length;n++){var r=a[n],o=r.getSnapshot;r=r.value;try{if(!xt(o(),r))return!1}catch(s){return!1}}}if(a=t.child,t.subtreeFlags&16384&&a!==null)a.return=t,t=a;else{if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return!0;t=t.return}t.sibling.return=t.return,t=t.sibling}}return!0}function Zt(e,t){t&=~oi,t&=~Ss,e.suspendedLanes|=t,e.pingedLanes&=~t;for(e=e.expirationTimes;0<t;){var a=31-ht(t),n=1<<a;e[a]=-1,t&=~n}}function Gd(e){if((q&6)!==0)throw Error(S(327));pn();var t=Qo(e,0);if((t&1)===0)return We(e,me()),null;var a=hs(e,t);if(e.tag!==0&&a===2){var n=Gl(e);n!==0&&(t=n,a=vu(e,n))}if(a===1)throw a=kr,Pa(e,0),Zt(e,t),We(e,me()),a;if(a===6)throw Error(S(345));return e.finishedWork=e.current.alternate,e.finishedLanes=t,ka(e,Oe,Bt),We(e,me()),null}function b0(e,t){var a=q;q|=1;try{return e(t)}finally{q=a,q===0&&(yn=me()+500,vs&&fa())}}function bs(e){Yt!==null&&Yt.tag===0&&(q&6)===0&&pn();var t=q;q|=1;var a=at.transition,n=K;try{if(at.transition=null,K=1,e)return e()}finally{K=n,at.transition=a,q=t,(q&6)===0&&fa()}}function li(){je=sn.current,ae(sn)}function Pa(e,t){e.finishedWork=null,e.finishedLanes=0;var a=e.timeoutHandle;if(a!==-1&&(e.timeoutHandle=-1,t0(a)),ge!==null)for(a=ge.return;a!==null;){var n=a;switch(qu(n),n.tag){case 1:n=n.type.childContextTypes,n!==null&&n!==void 0&&as();break;case 3:wn(),ae(He),ae(Re),Qu();break;case 5:Zu(n);break;case 4:wn();break;case 13:ae(oe);break;case 19:ae(oe);break;case 10:ju(n.type._context);break;case 22:case 23:li()}a=a.return}if(Ie=e,ge=e=sa(e.current,null),Pe=je=t,we=0,kr=null,oi=Ss=Ta=0,Oe=sr=null,Sa!==null){for(t=0;t<Sa.length;t++)if(a=Sa[t],n=a.interleaved,n!==null){a.interleaved=null;var r=n.next,o=a.pending;if(o!==null){var s=o.next;o.next=r,n.next=s}a.pending=n}Sa=null}return e}function Rc(e,t){do{var a=ge;try{if(Gu(),Ho.current=fs,ds){for(var n=se.memoizedState;n!==null;){var r=n.queue;r!==null&&(r.pending=null),n=n.next}ds=!1}if(za=0,ve=xe=se=null,rr=!1,yr=0,ri.current=null,a===null||a.return===null){we=1,kr=t,ge=null;break}e:{var o=e,s=a.return,l=a,u=t;if(t=Pe,l.flags|=32768,u!==null&&typeof u==="object"&&typeof u.then==="function"){var c=u,m=l,g=m.tag;if((m.mode&1)===0&&(g===0||g===11||g===15)){var h=m.alternate;h?(m.updateQueue=h.updateQueue,m.memoizedState=h.memoizedState,m.lanes=h.lanes):(m.updateQueue=null,m.memoizedState=null)}var w=Td(s);if(w!==null){w.flags&=-257,Rd(w,s,l,o,t),w.mode&1&&zd(o,c,t),t=w,u=c;var x=t.updateQueue;if(x===null){var k=new Set;k.add(u),t.updateQueue=k}else x.add(u);break e}else{if((t&1)===0){zd(o,c,t),ui();break e}u=Error(S(426))}}else if(ne&&l.mode&1){var B=Td(s);if(B!==null){(B.flags&65536)===0&&(B.flags|=256),Rd(B,s,l,o,t),Wu(Ln(u,l));break e}}o=u=Ln(u,l),we!==4&&(we=2),sr===null?sr=[o]:sr.push(o),o=s;do{switch(o.tag){case 3:o.flags|=65536,t&=-t,o.lanes|=t;var f=gc(o,u,t);Sd(o,f);break e;case 1:l=u;var d=o.type,p=o.stateNode;if((o.flags&128)===0&&(typeof d.getDerivedStateFromError==="function"||p!==null&&typeof p.componentDidCatch==="function"&&(ra===null||!ra.has(p)))){o.flags|=65536,t&=-t,o.lanes|=t;var L=xc(o,l,t);Sd(o,L);break e}}o=o.return}while(o!==null)}Bc(a)}catch(I){t=I,ge===a&&a!==null&&(ge=a=a.return);continue}break}while(1)}function Fc(){var e=cs.current;return cs.current=fs,e===null?fs:e}function ui(){if(we===0||we===3||we===2)we=4;Ie===null||(Ta&268435455)===0&&(Ss&268435455)===0||Zt(Ie,Pe)}function hs(e,t){var a=q;q|=2;var n=Fc();if(Ie!==e||Pe!==t)Bt=null,Pa(e,t);do try{P0();break}catch(r){Rc(e,r)}while(1);if(Gu(),q=a,cs.current=n,ge!==null)throw Error(S(261));return Ie=null,Pe=0,we}function P0(){for(;ge!==null;)Dc(ge)}function M0(){for(;ge!==null&&!eh();)Dc(ge)}function Dc(e){var t=Nc(e.alternate,e,je);e.memoizedProps=e.pendingProps,t===null?Bc(e):ge=t,ri.current=null}function Bc(e){var t=e;do{var a=t.alternate;if(e=t.return,(t.flags&32768)===0){if(a=L0(a,t,je),a!==null){ge=a;return}}else{if(a=y0(a,t),a!==null){a.flags&=32767,ge=a;return}if(e!==null)e.flags|=32768,e.subtreeFlags=0,e.deletions=null;else{we=6,ge=null;return}}if(t=t.sibling,t!==null){ge=t;return}ge=t=e}while(t!==null);we===0&&(we=5)}function ka(e,t,a){var n=K,r=at.transition;try{at.transition=null,K=1,_0(e,t,a,n)}finally{at.transition=r,K=n}return null}function _0(e,t,a,n){do pn();while(Yt!==null);if((q&6)!==0)throw Error(S(327));a=e.finishedWork;var r=e.finishedLanes;if(a===null)return null;if(e.finishedWork=null,e.finishedLanes=0,a===e.current)throw Error(S(177));e.callbackNode=null,e.callbackPriority=0;var o=a.lanes|a.childLanes;if(dh(e,o),e===Ie&&(ge=Ie=null,Pe=0),(a.subtreeFlags&2064)===0&&(a.flags&2064)===0||Do||(Do=!0,Oc(Zo,function(){return pn(),null})),o=(a.flags&15990)!==0,(a.subtreeFlags&15990)!==0||o){o=at.transition,at.transition=null;var s=K;K=1;var l=q;q|=4,ri.current=null,I0(e,a),Ac(a,e),Zh(Jl),Yo=!!Yl,Jl=Yl=null,e.current=a,k0(a,e,r),th(),q=l,K=s,at.transition=o}else e.current=a;if(Do&&(Do=!1,Yt=e,ms=r),o=e.pendingLanes,o===0&&(ra=null),rh(a.stateNode,n),We(e,me()),t!==null)for(n=e.onRecoverableError,a=0;a<t.length;a++)r=t[a],n(r.value,{componentStack:r.stack,digest:r.digest});if(ps)throw ps=!1,e=Lu,Lu=null,e;return(ms&1)!==0&&e.tag!==0&&pn(),o=e.pendingLanes,(o&1)!==0?e===yu?lr++:(lr=0,yu=e):lr=0,fa(),null}function pn(){if(Yt!==null){var e=gf(ms),t=at.transition,a=K;try{if(at.transition=null,K=16>e?16:e,Yt===null)var n=!1;else{if(e=Yt,Yt=null,ms=0,(q&6)!==0)throw Error(S(331));var r=q;q|=4;for(R=e.current;R!==null;){var o=R,s=o.child;if((R.flags&16)!==0){var l=o.deletions;if(l!==null){for(var u=0;u<l.length;u++){var c=l[u];for(R=c;R!==null;){var m=R;switch(m.tag){case 0:case 11:case 15:or(8,m,o)}var g=m.child;if(g!==null)g.return=m,R=g;else for(;R!==null;){m=R;var h=m.sibling,w=m.return;if(Pc(m),m===c){R=null;break}if(h!==null){h.return=w,R=h;break}R=w}}}var x=o.alternate;if(x!==null){var k=x.child;if(k!==null){x.child=null;do{var B=k.sibling;k.sibling=null,k=B}while(k!==null)}}R=o}}if((o.subtreeFlags&2064)!==0&&s!==null)s.return=o,R=s;else e:for(;R!==null;){if(o=R,(o.flags&2048)!==0)switch(o.tag){case 0:case 11:case 15:or(9,o,o.return)}var f=o.sibling;if(f!==null){f.return=o.return,R=f;break e}R=o.return}}var d=e.current;for(R=d;R!==null;){s=R;var p=s.child;if((s.subtreeFlags&2064)!==0&&p!==null)p.return=s,R=p;else e:for(s=d;R!==null;){if(l=R,(l.flags&2048)!==0)try{switch(l.tag){case 0:case 11:case 15:Cs(9,l)}}catch(I){de(l,l.return,I)}if(l===s){R=null;break e}var L=l.sibling;if(L!==null){L.return=l.return,R=L;break e}R=l.return}}if(q=r,fa(),_t&&typeof _t.onPostCommitFiberRoot==="function")try{_t.onPostCommitFiberRoot(gs,e)}catch(I){}n=!0}return n}finally{K=a,at.transition=t}}return!1}function jd(e,t,a){t=Ln(a,t),t=gc(e,t,1),e=na(e,t,1),t=Ee(),e!==null&&(Cr(e,1,t),We(e,t))}function de(e,t,a){if(e.tag===3)jd(e,e,a);else for(;t!==null;){if(t.tag===3){jd(t,e,a);break}else if(t.tag===1){var n=t.stateNode;if(typeof t.type.getDerivedStateFromError==="function"||typeof n.componentDidCatch==="function"&&(ra===null||!ra.has(n))){e=Ln(a,e),e=xc(t,e,1),t=na(t,e,1),e=Ee(),t!==null&&(Cr(t,1,e),We(t,e));break}}t=t.return}}function A0(e,t,a){var n=e.pingCache;n!==null&&n.delete(t),t=Ee(),e.pingedLanes|=e.suspendedLanes&a,Ie===e&&(Pe&a)===a&&(we===4||we===3&&(Pe&130023424)===Pe&&500>me()-si?Pa(e,0):oi|=a),We(e,t)}function Ec(e,t){t===0&&((e.mode&1)===0?t=1:(t=So,So<<=1,(So&130023424)===0&&(So=4194304)));var a=Ee();e=qt(e,t),e!==null&&(Cr(e,t,a),We(e,a))}function z0(e){var t=e.memoizedState,a=0;t!==null&&(a=t.retryLane),Ec(e,a)}function T0(e,t){var a=0;switch(e.tag){case 13:var{stateNode:n,memoizedState:r}=e;r!==null&&(a=r.retryLane);break;case 19:n=e.stateNode;break;default:throw Error(S(314))}n!==null&&n.delete(t),Ec(e,a)}function Oc(e,t){return cf(e,t)}function R0(e,t,a,n){this.tag=e,this.key=a,this.sibling=this.child=this.return=this.stateNode=this.type=this.elementType=null,this.index=0,this.ref=null,this.pendingProps=t,this.dependencies=this.memoizedState=this.updateQueue=this.memoizedProps=null,this.mode=n,this.subtreeFlags=this.flags=0,this.deletions=null,this.childLanes=this.lanes=0,this.alternate=null}function tt(e,t,a,n){return new R0(e,t,a,n)}function ii(e){return e=e.prototype,!(!e||!e.isReactComponent)}function F0(e){if(typeof e==="function")return ii(e)?1:0;if(e!==void 0&&e!==null){if(e=e.$$typeof,e===Pu)return 11;if(e===Mu)return 14}return 2}function sa(e,t){var a=e.alternate;return a===null?(a=tt(e.tag,t,e.key,e.mode),a.elementType=e.elementType,a.type=e.type,a.stateNode=e.stateNode,a.alternate=e,e.alternate=a):(a.pendingProps=t,a.type=e.type,a.flags=0,a.subtreeFlags=0,a.deletions=null),a.flags=e.flags&14680064,a.childLanes=e.childLanes,a.lanes=e.lanes,a.child=e.child,a.memoizedProps=e.memoizedProps,a.memoizedState=e.memoizedState,a.updateQueue=e.updateQueue,t=e.dependencies,a.dependencies=t===null?null:{lanes:t.lanes,firstContext:t.firstContext},a.sibling=e.sibling,a.index=e.index,a.ref=e.ref,a}function jo(e,t,a,n,r,o){var s=2;if(n=e,typeof e==="function")ii(e)&&(s=1);else if(typeof e==="string")s=5;else e:switch(e){case Qa:return Ma(a.children,r,o,t);case bu:s=8,r|=8;break;case Al:return e=tt(12,a,t,r|2),e.elementType=Al,e.lanes=o,e;case zl:return e=tt(13,a,t,r),e.elementType=zl,e.lanes=o,e;case Tl:return e=tt(19,a,t,r),e.elementType=Tl,e.lanes=o,e;case Qd:return Ps(a,r,o,t);default:if(typeof e==="object"&&e!==null)switch(e.$$typeof){case Xd:s=10;break e;case Zd:s=9;break e;case Pu:s=11;break e;case Mu:s=14;break e;case $t:s=16,n=null;break e}throw Error(S(130,e==null?e:typeof e,""))}return t=tt(s,a,t,r),t.elementType=e,t.type=n,t.lanes=o,t}function Ma(e,t,a,n){return e=tt(7,e,n,t),e.lanes=a,e}function Ps(e,t,a,n){return e=tt(22,e,n,t),e.elementType=Qd,e.lanes=a,e.stateNode={isHidden:!1},e}function Pl(e,t,a){return e=tt(6,e,null,t),e.lanes=a,e}function Ml(e,t,a){return t=tt(4,e.children!==null?e.children:[],e.key,t),t.lanes=a,t.stateNode={containerInfo:e.containerInfo,pendingChildren:null,implementation:e.implementation},t}function D0(e,t,a,n,r){this.tag=t,this.containerInfo=e,this.finishedWork=this.pingCache=this.current=this.pendingChildren=null,this.timeoutHandle=-1,this.callbackNode=this.pendingContext=this.context=null,this.callbackPriority=0,this.eventTimes=cl(0),this.expirationTimes=cl(-1),this.entangledLanes=this.finishedLanes=this.mutableReadLanes=this.expiredLanes=this.pingedLanes=this.suspendedLanes=this.pendingLanes=0,this.entanglements=cl(0),this.identifierPrefix=n,this.onRecoverableError=r,this.mutableSourceEagerHydrationData=null}function Uc(e,t,a,n,r,o,s,l,u){return e=new D0(e,t,a,l,u),t===1?(t=1,o===!0&&(t|=8)):t=0,o=tt(3,null,null,t),e.current=o,o.stateNode=e,o.memoizedState={element:n,isDehydrated:a,cache:null,transitions:null,pendingSuspenseBoundaries:null},Ku(o),e}function Hc(e){if(!e)return ua;e=e._reactInternals;e:{if(Fa(e)!==e||e.tag!==1)throw Error(S(170));var t=e;do{switch(t.tag){case 3:t=t.stateNode.context;break e;case 1:if(qe(t.type)){t=t.stateNode.__reactInternalMemoizedMergedChildContext;break e}}t=t.return}while(t!==null);throw Error(S(171))}if(e.tag===1){var a=e.type;if(qe(a))return Uf(e,a,t)}return t}function B0(e,t,a,n,r,o,s,l,u){return e=Uc(a,n,!0,e,r,o,s,l,u),e.context=Hc(null),a=e.current,n=Ee(),r=oa(a),o=Ut(n,r),o.callback=t!==void 0&&t!==null?t:null,na(a,o,r),e.current.lanes=r,Cr(e,r,n),We(e,n),e}function qc(e,t,a,n){var r=t.current,o=Ee(),s=oa(r);return a=Hc(a),t.context===null?t.context=a:t.pendingContext=a,t=Ut(o,s),t.payload={element:e},n=n===void 0?null:n,n!==null&&(t.callback=n),e=na(r,t,s),e!==null&&(gt(e,r,s,o),Uo(e,r,s)),s}function $d(e,t){if(e=e.memoizedState,e!==null&&e.dehydrated!==null){var a=e.retryLane;e.retryLane=a!==0&&a<t?a:t}}function di(e,t){$d(e,t),(e=e.alternate)&&$d(e,t)}function E0(){return null}function fi(e){this._internalRoot=e}function Ms(e){this._internalRoot=e}function Vc(e){return!(!e||e.nodeType!==1&&e.nodeType!==9&&e.nodeType!==11)}var re,Kd,ur,Ht,_l,Em,Gi,ji,Me,ku,Vt,vo,Wn,Qa,bu,Al,Xd,Zd,Pu,zl,Tl,Mu,$t,Qd,$i,le,ul,il=!1,Gn,ko,nf,Jn,Vm,Gm,Hl=null,ql=null,un=null,dn=null,fl=!1,Wl=!1,va,er=!1,Ko=null,Xo=!1,Vl=null,Xm,cf,ed,eh,th,me,ah,Au,pf,Zo,nh,mf,gs=null,_t=null,ht,oh,sh,Co=64,So=4194304,K=0,xf,Tu,wf,Lf,yf,jl=!1,bo,Jt=null,ea=null,ta=null,fr,cr,Xt,fh,fn,Yo=!0,Jo=null,Qt=null,Fu=null,Eo=null,vn,Du,Sr,gh,pl,ml,On,xs,rd,xh,wh,Lh,hl,yh,vh,Ih,kh,Ch,od,Sh,bh,Ph,_h,Ah,zh,sd,Th,Rh,Fh,Dh,Bh,Eh,Nh,Eu,tr=null,Oh,Cf,ld,ud=!1,Ya=!1,qh,ar=null,mr=null,Mf=!1,$n,Kn,Oo,xt,Qh,Ja=null,Kl=null,nr=null,Xl=!1,en,gl,Tf,Rf,Ff,Df,Bf,Ef,md,Zn,Zl,Ql,Xn,Qn,Yh,_o,Jh,e0,Yl=null,Jl=null,tu,t0,wd,a0,In,Mt,xr,kn,au,r0,o0,nu,tn=-1,ua,Re,He,_a,Et=null,vs=!1,yl=!1,an,nn=0,rs=null,os=0,Je,et=0,Aa=null,Nt=1,Ot="",Ke=null,$e=null,ne=!1,mt=null,l0,xn,jf,ss,ls=null,rn=null,Vu=null,Sa=null,Kt=!1,br,At,wr,Lr,oe,vl,Ho,Il,za=0,se=null,xe=null,ve=null,ds=!1,rr=!1,yr=0,u0=0,fs,c0,p0,m0,ks,h0,g0,Ue=!1,cu,Cc,mu,Sc,bc,Fo=!1,Te=!1,v0,R=null,Od=!1,be=null,pt=!1,C0,cs,ri,at,q=0,Ie=null,ge=null,Pe=0,je=0,sn,we=0,kr=null,Ta=0,Ss=0,oi=0,sr=null,Oe=null,si=0,yn=1/0,Bt=null,ps=!1,Lu=null,ra=null,Do=!1,Yt=null,ms=0,lr=0,yu=null,Vo=-1,Go=0,Nc,Wc,qn,N0,Za,ci=function(e,t){if(!Vc(e))throw Error(S(299));var a=!1,n="",r=Wc;return t!==null&&t!==void 0&&(t.unstable_strictMode===!0&&(a=!0),t.identifierPrefix!==void 0&&(n=t.identifierPrefix),t.onRecoverableError!==void 0&&(r=t.onRecoverableError)),t=Uc(e,1,!1,null,null,a,!1,n,r),e[kn]=t.current,Ou(e.nodeType===8?e.parentNode:e),new fi(t)},_s=function(e){return bs(e)},pi=function(e,t,a){if(!Vc(e))throw Error(S(405));var n=a!=null&&a.hydratedSources||null,r=!1,o="",s=Wc;if(a!==null&&a!==void 0&&(a.unstable_strictMode===!0&&(r=!0),a.identifierPrefix!==void 0&&(o=a.identifierPrefix),a.onRecoverableError!==void 0&&(s=a.onRecoverableError)),t=B0(t,null,e,1,a!=null?a:null,r,!1,o,s),e[kn]=t.current,Ou(e),n)for(e=0;e<n.length;e++)a=n[e],r=a._getVersion,r=r(a._source),t.mutableSourceEagerHydrationData==null?t.mutableSourceEagerHydrationData=[a,r]:t.mutableSourceEagerHydrationData.push(a,r);return new Ms(t)};var Gc=Xs(()=>{it();re=Ai(Vi());Kd=new Set,ur={};Ht=!(typeof window>"u"||typeof window.document>"u"||typeof window.document.createElement>"u"),_l=Object.prototype.hasOwnProperty,Em=/^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$/,Gi={},ji={};Me={};"children dangerouslySetInnerHTML defaultValue defaultChecked innerHTML suppressContentEditableWarning suppressHydrationWarning style".split(" ").forEach(function(e){Me[e]=new Ne(e,0,!1,e,null,!1,!1)});[["acceptCharset","accept-charset"],["className","class"],["htmlFor","for"],["httpEquiv","http-equiv"]].forEach(function(e){var t=e[0];Me[t]=new Ne(t,1,!1,e[1],null,!1,!1)});["contentEditable","draggable","spellCheck","value"].forEach(function(e){Me[e]=new Ne(e,2,!1,e.toLowerCase(),null,!1,!1)});["autoReverse","externalResourcesRequired","focusable","preserveAlpha"].forEach(function(e){Me[e]=new Ne(e,2,!1,e,null,!1,!1)});"allowFullScreen async autoFocus autoPlay controls default defer disabled disablePictureInPicture disableRemotePlayback formNoValidate hidden loop noModule noValidate open playsInline readOnly required reversed scoped seamless itemScope".split(" ").forEach(function(e){Me[e]=new Ne(e,3,!1,e.toLowerCase(),null,!1,!1)});["checked","multiple","muted","selected"].forEach(function(e){Me[e]=new Ne(e,3,!0,e,null,!1,!1)});["capture","download"].forEach(function(e){Me[e]=new Ne(e,4,!1,e,null,!1,!1)});["cols","rows","size","span"].forEach(function(e){Me[e]=new Ne(e,6,!1,e,null,!1,!1)});["rowSpan","start"].forEach(function(e){Me[e]=new Ne(e,5,!1,e.toLowerCase(),null,!1,!1)});ku=/[\-:]([a-z])/g;"accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y word-spacing writing-mode xmlns:xlink x-height".split(" ").forEach(function(e){var t=e.replace(ku,Cu);Me[t]=new Ne(t,1,!1,e,null,!1,!1)});"xlink:actuate xlink:arcrole xlink:role xlink:show xlink:title xlink:type".split(" ").forEach(function(e){var t=e.replace(ku,Cu);Me[t]=new Ne(t,1,!1,e,"http://www.w3.org/1999/xlink",!1,!1)});["xml:base","xml:lang","xml:space"].forEach(function(e){var t=e.replace(ku,Cu);Me[t]=new Ne(t,1,!1,e,"http://www.w3.org/XML/1998/namespace",!1,!1)});["tabIndex","crossOrigin"].forEach(function(e){Me[e]=new Ne(e,1,!1,e.toLowerCase(),null,!1,!1)});Me.xlinkHref=new Ne("xlinkHref",1,!1,"xlink:href","http://www.w3.org/1999/xlink",!0,!1);["src","href","action","formAction"].forEach(function(e){Me[e]=new Ne(e,1,!1,e.toLowerCase(),null,!0,!0)});Vt=_n,vo=Symbol.for("react.element"),Wn=Symbol.for("react.portal"),Qa=Symbol.for("react.fragment"),bu=Symbol.for("react.strict_mode"),Al=Symbol.for("react.profiler"),Xd=Symbol.for("react.provider"),Zd=Symbol.for("react.context"),Pu=Symbol.for("react.forward_ref"),zl=Symbol.for("react.suspense"),Tl=Symbol.for("react.suspense_list"),Mu=Symbol.for("react.memo"),$t=Symbol.for("react.lazy"),Qd=Symbol.for("react.offscreen"),$i=Symbol.iterator;le=Object.assign;Gn=Array.isArray;nf=function(e){return typeof MSApp<"u"&&MSApp.execUnsafeLocalFunction?function(t,a,n,r){MSApp.execUnsafeLocalFunction(function(){return e(t,a,n,r)})}:e}(function(e,t){if(e.namespaceURI!=="http://www.w3.org/2000/svg"||"innerHTML"in e)e.innerHTML=t;else{ko=ko||document.createElement("div"),ko.innerHTML="<svg>"+t.valueOf().toString()+"</svg>";for(t=ko.firstChild;e.firstChild;)e.removeChild(e.firstChild);for(;t.firstChild;)e.appendChild(t.firstChild)}});Jn={animationIterationCount:!0,aspectRatio:!0,borderImageOutset:!0,borderImageSlice:!0,borderImageWidth:!0,boxFlex:!0,boxFlexGroup:!0,boxOrdinalGroup:!0,columnCount:!0,columns:!0,flex:!0,flexGrow:!0,flexPositive:!0,flexShrink:!0,flexNegative:!0,flexOrder:!0,gridArea:!0,gridRow:!0,gridRowEnd:!0,gridRowSpan:!0,gridRowStart:!0,gridColumn:!0,gridColumnEnd:!0,gridColumnSpan:!0,gridColumnStart:!0,fontWeight:!0,lineClamp:!0,lineHeight:!0,opacity:!0,order:!0,orphans:!0,tabSize:!0,widows:!0,zIndex:!0,zoom:!0,fillOpacity:!0,floodOpacity:!0,stopOpacity:!0,strokeDasharray:!0,strokeDashoffset:!0,strokeMiterlimit:!0,strokeOpacity:!0,strokeWidth:!0},Vm=["Webkit","ms","Moz","O"];Object.keys(Jn).forEach(function(e){Vm.forEach(function(t){t=t+e.charAt(0).toUpperCase()+e.substring(1),Jn[t]=Jn[e]})});Gm=le({menuitem:!0},{area:!0,base:!0,br:!0,col:!0,embed:!0,hr:!0,img:!0,input:!0,keygen:!0,link:!0,meta:!0,param:!0,source:!0,track:!0,wbr:!0});if(Ht)try{va={},Object.defineProperty(va,"passive",{get:function(){Wl=!0}}),window.addEventListener("test",va,va),window.removeEventListener("test",va,va)}catch(e){Wl=!1}Xm={onError:function(e){er=!0,Ko=e}};cf=re.unstable_scheduleCallback,ed=re.unstable_cancelCallback,eh=re.unstable_shouldYield,th=re.unstable_requestPaint,me=re.unstable_now,ah=re.unstable_getCurrentPriorityLevel,Au=re.unstable_ImmediatePriority,pf=re.unstable_UserBlockingPriority,Zo=re.unstable_NormalPriority,nh=re.unstable_LowPriority,mf=re.unstable_IdlePriority;ht=Math.clz32?Math.clz32:lh,oh=Math.log,sh=Math.LN2;bo=[],fr=new Map,cr=new Map,Xt=[],fh="mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset submit".split(" ");fn=Vt.ReactCurrentBatchConfig;vn={eventPhase:0,bubbles:0,cancelable:0,timeStamp:function(e){return e.timeStamp||Date.now()},defaultPrevented:0,isTrusted:0},Du=Xe(vn),Sr=le({},vn,{view:0,detail:0}),gh=Xe(Sr),xs=le({},Sr,{screenX:0,screenY:0,clientX:0,clientY:0,pageX:0,pageY:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,getModifierState:Bu,button:0,buttons:0,relatedTarget:function(e){return e.relatedTarget===void 0?e.fromElement===e.srcElement?e.toElement:e.fromElement:e.relatedTarget},movementX:function(e){if("movementX"in e)return e.movementX;return e!==On&&(On&&e.type==="mousemove"?(pl=e.screenX-On.screenX,ml=e.screenY-On.screenY):ml=pl=0,On=e),pl},movementY:function(e){return"movementY"in e?e.movementY:ml}}),rd=Xe(xs),xh=le({},xs,{dataTransfer:0}),wh=Xe(xh),Lh=le({},Sr,{relatedTarget:0}),hl=Xe(Lh),yh=le({},vn,{animationName:0,elapsedTime:0,pseudoElement:0}),vh=Xe(yh),Ih=le({},vn,{clipboardData:function(e){return"clipboardData"in e?e.clipboardData:window.clipboardData}}),kh=Xe(Ih),Ch=le({},vn,{data:0}),od=Xe(Ch),Sh={Esc:"Escape",Spacebar:" ",Left:"ArrowLeft",Up:"ArrowUp",Right:"ArrowRight",Down:"ArrowDown",Del:"Delete",Win:"OS",Menu:"ContextMenu",Apps:"ContextMenu",Scroll:"ScrollLock",MozPrintableKey:"Unidentified"},bh={8:"Backspace",9:"Tab",12:"Clear",13:"Enter",16:"Shift",17:"Control",18:"Alt",19:"Pause",20:"CapsLock",27:"Escape",32:" ",33:"PageUp",34:"PageDown",35:"End",36:"Home",37:"ArrowLeft",38:"ArrowUp",39:"ArrowRight",40:"ArrowDown",45:"Insert",46:"Delete",112:"F1",113:"F2",114:"F3",115:"F4",116:"F5",117:"F6",118:"F7",119:"F8",120:"F9",121:"F10",122:"F11",123:"F12",144:"NumLock",145:"ScrollLock",224:"Meta"},Ph={Alt:"altKey",Control:"ctrlKey",Meta:"metaKey",Shift:"shiftKey"};_h=le({},Sr,{key:function(e){if(e.key){var t=Sh[e.key]||e.key;if(t!=="Unidentified")return t}return e.type==="keypress"?(e=No(e),e===13?"Enter":String.fromCharCode(e)):e.type==="keydown"||e.type==="keyup"?bh[e.keyCode]||"Unidentified":""},code:0,location:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,repeat:0,locale:0,getModifierState:Bu,charCode:function(e){return e.type==="keypress"?No(e):0},keyCode:function(e){return e.type==="keydown"||e.type==="keyup"?e.keyCode:0},which:function(e){return e.type==="keypress"?No(e):e.type==="keydown"||e.type==="keyup"?e.keyCode:0}}),Ah=Xe(_h),zh=le({},xs,{pointerId:0,width:0,height:0,pressure:0,tangentialPressure:0,tiltX:0,tiltY:0,twist:0,pointerType:0,isPrimary:0}),sd=Xe(zh),Th=le({},Sr,{touches:0,targetTouches:0,changedTouches:0,altKey:0,metaKey:0,ctrlKey:0,shiftKey:0,getModifierState:Bu}),Rh=Xe(Th),Fh=le({},vn,{propertyName:0,elapsedTime:0,pseudoElement:0}),Dh=Xe(Fh),Bh=le({},xs,{deltaX:function(e){return"deltaX"in e?e.deltaX:("wheelDeltaX"in e)?-e.wheelDeltaX:0},deltaY:function(e){return"deltaY"in e?e.deltaY:("wheelDeltaY"in e)?-e.wheelDeltaY:("wheelDelta"in e)?-e.wheelDelta:0},deltaZ:0,deltaMode:0}),Eh=Xe(Bh),Nh=[9,13,27,32],Eu=Ht&&"CompositionEvent"in window;Ht&&"documentMode"in document&&(tr=document.documentMode);Oh=Ht&&"TextEvent"in window&&!tr,Cf=Ht&&(!Eu||tr&&8<tr&&11>=tr),ld=String.fromCharCode(32);qh={color:!0,date:!0,datetime:!0,"datetime-local":!0,email:!0,month:!0,number:!0,password:!0,range:!0,search:!0,tel:!0,text:!0,time:!0,url:!0,week:!0};if(Ht){if(Ht){if(Kn="oninput"in document,!Kn)Oo=document.createElement("div"),Oo.setAttribute("oninput","return;"),Kn=typeof Oo.oninput==="function";$n=Kn}else $n=!1;Mf=$n&&(!document.documentMode||9<document.documentMode)}xt=typeof Object.is==="function"?Object.is:Xh;Qh=Ht&&"documentMode"in document&&11>=document.documentMode;en={animationend:Mo("Animation","AnimationEnd"),animationiteration:Mo("Animation","AnimationIteration"),animationstart:Mo("Animation","AnimationStart"),transitionend:Mo("Transition","TransitionEnd")},gl={},Tf={};Ht&&(Tf=document.createElement("div").style,("AnimationEvent"in window)||(delete en.animationend.animation,delete en.animationiteration.animation,delete en.animationstart.animation),("TransitionEvent"in window)||delete en.transitionend.transition);Rf=Ls("animationend"),Ff=Ls("animationiteration"),Df=Ls("animationstart"),Bf=Ls("transitionend"),Ef=new Map,md="abort auxClick cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");for(Xn=0;Xn<md.length;Xn++)Zn=md[Xn],Zl=Zn.toLowerCase(),Ql=Zn[0].toUpperCase()+Zn.slice(1),ia(Zl,"on"+Ql);ia(Rf,"onAnimationEnd");ia(Ff,"onAnimationIteration");ia(Df,"onAnimationStart");ia("dblclick","onDoubleClick");ia("focusin","onFocus");ia("focusout","onBlur");ia(Bf,"onTransitionEnd");mn("onMouseEnter",["mouseout","mouseover"]);mn("onMouseLeave",["mouseout","mouseover"]);mn("onPointerEnter",["pointerout","pointerover"]);mn("onPointerLeave",["pointerout","pointerover"]);Ra("onChange","change click focusin focusout input keydown keyup selectionchange".split(" "));Ra("onSelect","focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" "));Ra("onBeforeInput",["compositionend","keypress","textInput","paste"]);Ra("onCompositionEnd","compositionend focusout keydown keypress keyup mousedown".split(" "));Ra("onCompositionStart","compositionstart focusout keydown keypress keyup mousedown".split(" "));Ra("onCompositionUpdate","compositionupdate focusout keydown keypress keyup mousedown".split(" "));Qn="abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" "),Yh=new Set("cancel close invalid load scroll toggle".split(" ").concat(Qn));_o="_reactListening"+Math.random().toString(36).slice(2);Jh=/\r\n?/g,e0=/\u0000|\uFFFD/g;tu=typeof setTimeout==="function"?setTimeout:void 0,t0=typeof clearTimeout==="function"?clearTimeout:void 0,wd=typeof Promise==="function"?Promise:void 0,a0=typeof queueMicrotask==="function"?queueMicrotask:typeof wd<"u"?function(e){return wd.resolve(null).then(e).catch(n0)}:tu;In=Math.random().toString(36).slice(2),Mt="__reactFiber$"+In,xr="__reactProps$"+In,kn="__reactContainer$"+In,au="__reactEvents$"+In,r0="__reactListeners$"+In,o0="__reactHandles$"+In;nu=[];ua={},Re=da(ua),He=da(!1),_a=ua;an=[],Je=[];l0=Vt.ReactCurrentBatchConfig;xn=Gf(!0),jf=Gf(!1),ss=da(null);br={},At=da(br),wr=da(br),Lr=da(br);oe=da(0);vl=[];Ho=Vt.ReactCurrentDispatcher,Il=Vt.ReactCurrentBatchConfig;fs={readContext:nt,useCallback:Ae,useContext:Ae,useEffect:Ae,useImperativeHandle:Ae,useInsertionEffect:Ae,useLayoutEffect:Ae,useMemo:Ae,useReducer:Ae,useRef:Ae,useState:Ae,useDebugValue:Ae,useDeferredValue:Ae,useTransition:Ae,useMutableSource:Ae,useSyncExternalStore:Ae,useId:Ae,unstable_isNewReconciler:!1},c0={readContext:nt,useCallback:function(e,t){return Pt().memoizedState=[e,t===void 0?null:t],e},useContext:nt,useEffect:Md,useImperativeHandle:function(e,t,a){return a=a!==null&&a!==void 0?a.concat([e]):null,qo(4194308,4,sc.bind(null,t,e),a)},useLayoutEffect:function(e,t){return qo(4194308,4,e,t)},useInsertionEffect:function(e,t){return qo(4,2,e,t)},useMemo:function(e,t){var a=Pt();return t=t===void 0?null:t,e=e(),a.memoizedState=[e,t],e},useReducer:function(e,t,a){var n=Pt();return t=a!==void 0?a(t):t,n.memoizedState=n.baseState=t,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:e,lastRenderedState:t},n.queue=e,e=e.dispatch=d0.bind(null,se,e),[n.memoizedState,e]},useRef:function(e){var t=Pt();return e={current:e},t.memoizedState=e},useState:Pd,useDebugValue:ai,useDeferredValue:function(e){return Pt().memoizedState=e},useTransition:function(){var e=Pd(!1),t=e[0];return e=i0.bind(null,e[1]),Pt().memoizedState=e,[t,e]},useMutableSource:function(){},useSyncExternalStore:function(e,t,a){var n=se,r=Pt();if(ne){if(a===void 0)throw Error(S(407));a=a()}else{if(a=t(),Ie===null)throw Error(S(349));(za&30)!==0||Yf(n,t,a)}r.memoizedState=a;var o={value:a,getSnapshot:t};return r.queue=o,Md(ec.bind(null,n,o,e),[e]),n.flags|=2048,Ir(9,Jf.bind(null,n,o,a,t),void 0,null),a},useId:function(){var e=Pt(),t=Ie.identifierPrefix;if(ne){var a=Ot,n=Nt;a=(n&~(1<<32-ht(n)-1)).toString(32)+a,t=":"+t+"R"+a,a=yr++,0<a&&(t+="H"+a.toString(32)),t+=":"}else a=u0++,t=":"+t+"r"+a.toString(32)+":";return e.memoizedState=t},unstable_isNewReconciler:!1},p0={readContext:nt,useCallback:uc,useContext:nt,useEffect:ti,useImperativeHandle:lc,useInsertionEffect:rc,useLayoutEffect:oc,useMemo:ic,useReducer:kl,useRef:nc,useState:function(){return kl(vr)},useDebugValue:ai,useDeferredValue:function(e){var t=rt();return dc(t,xe.memoizedState,e)},useTransition:function(){var e=kl(vr)[0],t=rt().memoizedState;return[e,t]},useMutableSource:Zf,useSyncExternalStore:Qf,useId:fc,unstable_isNewReconciler:!1},m0={readContext:nt,useCallback:uc,useContext:nt,useEffect:ti,useImperativeHandle:lc,useInsertionEffect:rc,useLayoutEffect:oc,useMemo:ic,useReducer:Cl,useRef:nc,useState:function(){return Cl(vr)},useDebugValue:ai,useDeferredValue:function(e){var t=rt();return xe===null?t.memoizedState=e:dc(t,xe.memoizedState,e)},useTransition:function(){var e=Cl(vr)[0],t=rt().memoizedState;return[e,t]},useMutableSource:Zf,useSyncExternalStore:Qf,useId:fc,unstable_isNewReconciler:!1};ks={isMounted:function(e){return(e=e._reactInternals)?Fa(e)===e:!1},enqueueSetState:function(e,t,a){e=e._reactInternals;var n=Ee(),r=oa(e),o=Ut(n,r);o.payload=t,a!==void 0&&a!==null&&(o.callback=a),t=na(e,o,r),t!==null&&(gt(t,e,r,n),Uo(t,e,r))},enqueueReplaceState:function(e,t,a){e=e._reactInternals;var n=Ee(),r=oa(e),o=Ut(n,r);o.tag=1,o.payload=t,a!==void 0&&a!==null&&(o.callback=a),t=na(e,o,r),t!==null&&(gt(t,e,r,n),Uo(t,e,r))},enqueueForceUpdate:function(e,t){e=e._reactInternals;var a=Ee(),n=oa(e),r=Ut(a,n);r.tag=2,t!==void 0&&t!==null&&(r.callback=t),t=na(e,r,n),t!==null&&(gt(t,e,n,a),Uo(t,e,n))}};h0=typeof WeakMap==="function"?WeakMap:Map;g0=Vt.ReactCurrentOwner;cu={dehydrated:null,treeContext:null,retryLane:0};Cc=function(e,t){for(var a=t.child;a!==null;){if(a.tag===5||a.tag===6)e.appendChild(a.stateNode);else if(a.tag!==4&&a.child!==null){a.child.return=a,a=a.child;continue}if(a===t)break;for(;a.sibling===null;){if(a.return===null||a.return===t)return;a=a.return}a.sibling.return=a.return,a=a.sibling}};mu=function(){};Sc=function(e,t,a,n){var r=e.memoizedProps;if(r!==n){e=t.stateNode,ba(At.current);var o=null;switch(a){case"input":r=Fl(e,r),n=Fl(e,n),o=[];break;case"select":r=le({},r,{value:void 0}),n=le({},n,{value:void 0}),o=[];break;case"textarea":r=El(e,r),n=El(e,n),o=[];break;default:typeof r.onClick!=="function"&&typeof n.onClick==="function"&&(e.onclick=ts)}Ol(a,n);var s;a=null;for(c in r)if(!n.hasOwnProperty(c)&&r.hasOwnProperty(c)&&r[c]!=null)if(c==="style"){var l=r[c];for(s in l)l.hasOwnProperty(s)&&(a||(a={}),a[s]="")}else c!=="dangerouslySetInnerHTML"&&c!=="children"&&c!=="suppressContentEditableWarning"&&c!=="suppressHydrationWarning"&&c!=="autoFocus"&&(ur.hasOwnProperty(c)?o||(o=[]):(o=o||[]).push(c,null));for(c in n){var u=n[c];if(l=r!=null?r[c]:void 0,n.hasOwnProperty(c)&&u!==l&&(u!=null||l!=null))if(c==="style")if(l){for(s in l)!l.hasOwnProperty(s)||u&&u.hasOwnProperty(s)||(a||(a={}),a[s]="");for(s in u)u.hasOwnProperty(s)&&l[s]!==u[s]&&(a||(a={}),a[s]=u[s])}else a||(o||(o=[]),o.push(c,a)),a=u;else c==="dangerouslySetInnerHTML"?(u=u?u.__html:void 0,l=l?l.__html:void 0,u!=null&&l!==u&&(o=o||[]).push(c,u)):c==="children"?typeof u!=="string"&&typeof u!=="number"||(o=o||[]).push(c,""+u):c!=="suppressContentEditableWarning"&&c!=="suppressHydrationWarning"&&(ur.hasOwnProperty(c)?(u!=null&&c==="onScroll"&&te("scroll",e),o||l===u||(o=[])):(o=o||[]).push(c,u))}a&&(o=o||[]).push("style",a);var c=o;if(t.updateQueue=c)t.flags|=4}};bc=function(e,t,a,n){a!==n&&(t.flags|=4)};v0=typeof WeakSet==="function"?WeakSet:Set;C0=Math.ceil,cs=Vt.ReactCurrentDispatcher,ri=Vt.ReactCurrentOwner,at=Vt.ReactCurrentBatchConfig,sn=da(0);Nc=function(e,t,a){if(e!==null)if(e.memoizedProps!==t.pendingProps||He.current)Ue=!0;else{if((e.lanes&a)===0&&(t.flags&128)===0)return Ue=!1,w0(e,t,a);Ue=(e.flags&131072)!==0?!0:!1}else Ue=!1,ne&&(t.flags&1048576)!==0&&qf(t,os,t.index);switch(t.lanes=0,t.tag){case 2:var n=t.type;Wo(e,t),e=t.pendingProps;var r=hn(t,Re.current);cn(t,a),r=Ju(null,t,n,e,r,a);var o=ei();return t.flags|=1,typeof r==="object"&&r!==null&&typeof r.render==="function"&&r.$$typeof===void 0?(t.tag=1,t.memoizedState=null,t.updateQueue=null,qe(n)?(o=!0,ns(t)):o=!1,t.memoizedState=r.state!==null&&r.state!==void 0?r.state:null,Ku(t),r.updater=ks,t.stateNode=r,r._reactInternals=t,uu(t,n,e,a),t=fu(null,t,n,!0,o,a)):(t.tag=0,ne&&o&&Hu(t),Be(null,t,r,a),t=t.child),t;case 16:n=t.elementType;e:{switch(Wo(e,t),e=t.pendingProps,r=n._init,n=r(n._payload),t.type=n,r=t.tag=F0(n),e=ct(n,e),r){case 0:t=du(null,t,n,e,a);break e;case 1:t=Bd(null,t,n,e,a);break e;case 11:t=Fd(null,t,n,e,a);break e;case 14:t=Dd(null,t,n,ct(n.type,e),a);break e}throw Error(S(306,n,""))}return t;case 0:return n=t.type,r=t.pendingProps,r=t.elementType===n?r:ct(n,r),du(e,t,n,r,a);case 1:return n=t.type,r=t.pendingProps,r=t.elementType===n?r:ct(n,r),Bd(e,t,n,r,a);case 3:e:{if(vc(t),e===null)throw Error(S(387));n=t.pendingProps,o=t.memoizedState,r=o.element,Kf(e,t),us(t,n,null,a);var s=t.memoizedState;if(n=s.element,o.isDehydrated)if(o={element:n,isDehydrated:!1,cache:s.cache,pendingSuspenseBoundaries:s.pendingSuspenseBoundaries,transitions:s.transitions},t.updateQueue.baseState=o,t.memoizedState=o,t.flags&256){r=Ln(Error(S(423)),t),t=Ed(e,t,n,a,r);break e}else if(n!==r){r=Ln(Error(S(424)),t),t=Ed(e,t,n,a,r);break e}else for($e=aa(t.stateNode.containerInfo.firstChild),Ke=t,ne=!0,mt=null,a=jf(t,null,n,a),t.child=a;a;)a.flags=a.flags&-3|4096,a=a.sibling;else{if(gn(),n===r){t=Wt(e,t,a);break e}Be(e,t,n,a)}t=t.child}return t;case 5:return Xf(t),e===null&&ou(t),n=t.type,r=t.pendingProps,o=e!==null?e.memoizedProps:null,s=r.children,eu(n,r)?s=null:o!==null&&eu(n,o)&&(t.flags|=32),yc(e,t),Be(e,t,s,a),t.child;case 6:return e===null&&ou(t),null;case 13:return Ic(e,t,a);case 4:return Xu(t,t.stateNode.containerInfo),n=t.pendingProps,e===null?t.child=xn(t,null,n,a):Be(e,t,n,a),t.child;case 11:return n=t.type,r=t.pendingProps,r=t.elementType===n?r:ct(n,r),Fd(e,t,n,r,a);case 7:return Be(e,t,t.pendingProps,a),t.child;case 8:return Be(e,t,t.pendingProps.children,a),t.child;case 12:return Be(e,t,t.pendingProps.children,a),t.child;case 10:e:{if(n=t.type._context,r=t.pendingProps,o=t.memoizedProps,s=r.value,Y(ss,n._currentValue),n._currentValue=s,o!==null)if(xt(o.value,s)){if(o.children===r.children&&!He.current){t=Wt(e,t,a);break e}}else for(o=t.child,o!==null&&(o.return=t);o!==null;){var l=o.dependencies;if(l!==null){s=o.child;for(var u=l.firstContext;u!==null;){if(u.context===n){if(o.tag===1){u=Ut(-1,a&-a),u.tag=2;var c=o.updateQueue;if(c!==null){c=c.shared;var m=c.pending;m===null?u.next=u:(u.next=m.next,m.next=u),c.pending=u}}o.lanes|=a,u=o.alternate,u!==null&&(u.lanes|=a),su(o.return,a,t),l.lanes|=a;break}u=u.next}}else if(o.tag===10)s=o.type===t.type?null:o.child;else if(o.tag===18){if(s=o.return,s===null)throw Error(S(341));s.lanes|=a,l=s.alternate,l!==null&&(l.lanes|=a),su(s,a,t),s=o.sibling}else s=o.child;if(s!==null)s.return=o;else for(s=o;s!==null;){if(s===t){s=null;break}if(o=s.sibling,o!==null){o.return=s.return,s=o;break}s=s.return}o=s}Be(e,t,r.children,a),t=t.child}return t;case 9:return r=t.type,n=t.pendingProps.children,cn(t,a),r=nt(r),n=n(r),t.flags|=1,Be(e,t,n,a),t.child;case 14:return n=t.type,r=ct(n,t.pendingProps),r=ct(n.type,r),Dd(e,t,n,r,a);case 15:return wc(e,t,t.type,t.pendingProps,a);case 17:return n=t.type,r=t.pendingProps,r=t.elementType===n?r:ct(n,r),Wo(e,t),t.tag=1,qe(n)?(e=!0,ns(t)):e=!1,cn(t,a),hc(t,n,r),uu(t,n,r,a),fu(null,t,n,!0,e,a);case 19:return kc(e,t,a);case 22:return Lc(e,t,a)}throw Error(S(156,t.tag))};Wc=typeof reportError==="function"?reportError:function(e){console.error(e)};Ms.prototype.render=fi.prototype.render=function(e){var t=this._internalRoot;if(t===null)throw Error(S(409));qc(e,t,null,null)};Ms.prototype.unmount=fi.prototype.unmount=function(){var e=this._internalRoot;if(e!==null){this._internalRoot=null;var t=e.containerInfo;bs(function(){qc(null,e,null,null)}),t[kn]=null}};Ms.prototype.unstable_scheduleHydration=function(e){if(e){var t=Lf();e={blockedOn:null,target:e,priority:t};for(var a=0;a<Xt.length&&t!==0&&t<Xt[a].priority;a++);Xt.splice(a,0,e),a===0&&vf(e)}};xf=function(e){switch(e.tag){case 3:var t=e.stateNode;if(t.current.memoizedState.isDehydrated){var a=jn(t.pendingLanes);a!==0&&(zu(t,a|1),We(t,me()),(q&6)===0&&(yn=me()+500,fa()))}break;case 13:bs(function(){var n=qt(e,1);if(n!==null){var r=Ee();gt(n,e,1,r)}}),di(e,1)}};Tu=function(e){if(e.tag===13){var t=qt(e,134217728);if(t!==null){var a=Ee();gt(t,e,134217728,a)}di(e,134217728)}};wf=function(e){if(e.tag===13){var t=oa(e),a=qt(e,t);if(a!==null){var n=Ee();gt(a,e,t,n)}di(e,t)}};Lf=function(){return K};yf=function(e,t){var a=K;try{return K=e,t()}finally{K=a}};ql=function(e,t,a){switch(t){case"input":if(Dl(e,a),t=a.name,a.type==="radio"&&t!=null){for(a=e;a.parentNode;)a=a.parentNode;a=a.querySelectorAll("input[name="+JSON.stringify(""+t)+'][type="radio"]');for(t=0;t<a.length;t++){var n=a[t];if(n!==e&&n.form===e.form){var r=Uu(n);if(!r)throw Error(S(90));Jd(n),Dl(n,r)}}}break;case"textarea":tf(e,a);break;case"select":t=a.value,t!=null&&ln(e,!!a.multiple,t,!1)}};sf=b0;lf=bs;qn={findFiberByHostInstance:Ca,bundleType:0,version:"18.3.1",rendererPackageName:"react-dom"},N0={bundleType:qn.bundleType,version:qn.version,rendererPackageName:qn.rendererPackageName,rendererConfig:qn.rendererConfig,overrideHookState:null,overrideHookStateDeletePath:null,overrideHookStateRenamePath:null,overrideProps:null,overridePropsDeletePath:null,overridePropsRenamePath:null,setErrorHandler:null,setSuspenseHandler:null,scheduleUpdate:null,currentDispatcherRef:Vt.ReactCurrentDispatcher,findHostInstanceByFiber:function(e){return e=Jm(e),e===null?null:e.stateNode},findFiberByHostInstance:qn.findFiberByHostInstance||E0,findHostInstancesForRefresh:null,scheduleRefresh:null,scheduleRoot:null,setRefreshHandler:null,getCurrentFiber:null,reconcilerVersion:"18.3.1-next-f1338f8080-20240426"};if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__<"u"){if(Za=__REACT_DEVTOOLS_GLOBAL_HOOK__,!Za.isDisabled&&Za.supportsFiber)try{gs=Za.inject(N0),_t=Za}catch(e){}}});function jc(){if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__>"u"||typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE!=="function")return;try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(jc)}catch(e){console.error(e)}}var mi=Xs(()=>{Gc();jc()});var $c=zi(function(H0){mi();H0.createRoot=ci,H0.hydrateRoot=pi;var U0});var $p=Ai($c(),1);var Kc=document.createElement("style");Kc.textContent=`/* The dotz look: the site's own tokens (style.css :root, light and dark)
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
`;document.head.appendChild(Kc);it();var Xc=(e)=>e.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase(),As=(...e)=>e.filter((t,a,n)=>Boolean(t)&&t.trim()!==""&&n.indexOf(t)===a).join(" ").trim();it();var Zc={xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};var Qc=zn(({color:e="currentColor",size:t=24,strokeWidth:a=2,absoluteStrokeWidth:n,className:r="",children:o,iconNode:s,...l},u)=>ja("svg",{ref:u,...Zc,width:t,height:t,stroke:e,strokeWidth:n?Number(a)*24/Number(t):a,className:As("lucide",r),...l},[...s.map(([c,m])=>ja(c,m)),...Array.isArray(o)?o:[o]]));var A=(e,t)=>{let a=zn(({className:n,...r},o)=>ja(Qc,{ref:o,iconNode:t,className:As(`lucide-${Xc(e)}`,n),...r}));return a.displayName=`${e}`,a};var ca=A("Ellipsis",[["circle",{cx:"12",cy:"12",r:"1",key:"41hilf"}],["circle",{cx:"19",cy:"12",r:"1",key:"1wjl8i"}],["circle",{cx:"5",cy:"12",r:"1",key:"1pcz8c"}]]);var zt=A("House",[["path",{d:"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8",key:"5wwlr5"}],["path",{d:"M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",key:"1d0kgt"}]]);var Pr=A("Activity",[["path",{d:"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2",key:"169zse"}]]);var Mr=A("Archive",[["rect",{width:"20",height:"5",x:"2",y:"3",rx:"1",key:"1wp1u1"}],["path",{d:"M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8",key:"1s80jp"}],["path",{d:"M10 12h4",key:"a56b0p"}]]);var _r=A("ArrowRight",[["path",{d:"M5 12h14",key:"1ays0h"}],["path",{d:"m12 5 7 7-7 7",key:"xquz4c"}]]);var Ar=A("ArrowUpRight",[["path",{d:"M7 7h10v10",key:"1tivn9"}],["path",{d:"M7 17 17 7",key:"1vkiza"}]]);var zr=A("ArrowUp",[["path",{d:"m5 12 7-7 7 7",key:"hav0vg"}],["path",{d:"M12 19V5",key:"x0mq9r"}]]);var Da=A("Bell",[["path",{d:"M10.268 21a2 2 0 0 0 3.464 0",key:"vwvbt9"}],["path",{d:"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",key:"11g9vi"}]]);var Tr=A("Calendar",[["path",{d:"M8 2v4",key:"1cmpym"}],["path",{d:"M16 2v4",key:"4m81vk"}],["rect",{width:"18",height:"18",x:"3",y:"4",rx:"2",key:"1hopcy"}],["path",{d:"M3 10h18",key:"8toen8"}]]);var Rr=A("Check",[["path",{d:"M20 6 9 17l-5-5",key:"1gmf2c"}]]);var Ba=A("ChevronDown",[["path",{d:"m6 9 6 6 6-6",key:"qrunsl"}]]);var Fr=A("ChevronLeft",[["path",{d:"m15 18-6-6 6-6",key:"1wnfg3"}]]);var Dr=A("ChevronRight",[["path",{d:"m9 18 6-6-6-6",key:"mthhwq"}]]);var Br=A("Clock",[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["polyline",{points:"12 6 12 12 16 14",key:"68esgv"}]]);var Er=A("CreditCard",[["rect",{width:"20",height:"14",x:"2",y:"5",rx:"2",key:"ynyp8z"}],["line",{x1:"2",x2:"22",y1:"10",y2:"10",key:"1b3vmo"}]]);var Nr=A("File",[["path",{d:"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",key:"1rqfz7"}],["path",{d:"M14 2v4a2 2 0 0 0 2 2h4",key:"tnqrlb"}]]);var Or=A("Folder",[["path",{d:"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",key:"1kt360"}]]);var Ur=A("Globe",[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["path",{d:"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",key:"13o1zl"}],["path",{d:"M2 12h20",key:"9i4pu4"}]]);var Hr=A("GripVertical",[["circle",{cx:"9",cy:"12",r:"1",key:"1vctgf"}],["circle",{cx:"9",cy:"5",r:"1",key:"hp0tcf"}],["circle",{cx:"9",cy:"19",r:"1",key:"fkjjf6"}],["circle",{cx:"15",cy:"12",r:"1",key:"1tmaij"}],["circle",{cx:"15",cy:"5",r:"1",key:"19l28e"}],["circle",{cx:"15",cy:"19",r:"1",key:"f4zoj3"}]]);var qr=A("Heart",[["path",{d:"M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",key:"c3ymky"}]]);var Wr=A("Lock",[["rect",{width:"18",height:"11",x:"3",y:"11",rx:"2",ry:"2",key:"1w4ew1"}],["path",{d:"M7 11V7a5 5 0 0 1 10 0v4",key:"fwvmzm"}]]);var Vr=A("Mail",[["rect",{width:"20",height:"16",x:"2",y:"4",rx:"2",key:"18n3k1"}],["path",{d:"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7",key:"1ocrg3"}]]);var Gr=A("MessageCircle",[["path",{d:"M7.9 20A9 9 0 1 0 4 16.1L2 22Z",key:"vv11sd"}]]);var jr=A("Pause",[["rect",{x:"14",y:"4",width:"4",height:"16",rx:"1",key:"zuxfzm"}],["rect",{x:"6",y:"4",width:"4",height:"16",rx:"1",key:"1okwgv"}]]);var $r=A("Play",[["polygon",{points:"6 3 20 12 6 21 6 3",key:"1oa8hb"}]]);var Ea=A("Plus",[["path",{d:"M5 12h14",key:"1ays0h"}],["path",{d:"M12 5v14",key:"s699le"}]]);var Kr=A("ScanFace",[["path",{d:"M3 7V5a2 2 0 0 1 2-2h2",key:"aa7l1z"}],["path",{d:"M17 3h2a2 2 0 0 1 2 2v2",key:"4qcy5o"}],["path",{d:"M21 17v2a2 2 0 0 1-2 2h-2",key:"6vwrx8"}],["path",{d:"M7 21H5a2 2 0 0 1-2-2v-2",key:"ioqczr"}],["path",{d:"M8 14s1.5 2 4 2 4-2 4-2",key:"1y1vjs"}],["path",{d:"M9 9h.01",key:"1q5me6"}],["path",{d:"M15 9h.01",key:"x1ddxp"}]]);var Na=A("Search",[["circle",{cx:"11",cy:"11",r:"8",key:"4ej97u"}],["path",{d:"m21 21-4.3-4.3",key:"1qie3q"}]]);var Xr=A("Send",[["path",{d:"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",key:"1ffxy3"}],["path",{d:"m21.854 2.147-10.94 10.939",key:"12cjpa"}]]);var Zr=A("Settings",[["path",{d:"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",key:"1qme2f"}],["circle",{cx:"12",cy:"12",r:"3",key:"1v7zrd"}]]);var Qr=A("SlidersHorizontal",[["line",{x1:"21",x2:"14",y1:"4",y2:"4",key:"obuewd"}],["line",{x1:"10",x2:"3",y1:"4",y2:"4",key:"1q6298"}],["line",{x1:"21",x2:"12",y1:"12",y2:"12",key:"1iu8h1"}],["line",{x1:"8",x2:"3",y1:"12",y2:"12",key:"ntss68"}],["line",{x1:"21",x2:"16",y1:"20",y2:"20",key:"14d8ph"}],["line",{x1:"12",x2:"3",y1:"20",y2:"20",key:"m0wm8r"}],["line",{x1:"14",x2:"14",y1:"2",y2:"6",key:"14e1ph"}],["line",{x1:"8",x2:"8",y1:"10",y2:"14",key:"1i6ji0"}],["line",{x1:"16",x2:"16",y1:"18",y2:"22",key:"1lctlv"}]]);var Yr=A("Star",[["path",{d:"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",key:"r04s7s"}]]);var Jr=A("Trash2",[["path",{d:"M3 6h18",key:"d0wm0j"}],["path",{d:"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6",key:"4alrt4"}],["path",{d:"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2",key:"v07s0e"}],["line",{x1:"10",x2:"10",y1:"11",y2:"17",key:"1uufr5"}],["line",{x1:"14",x2:"14",y1:"11",y2:"17",key:"xtxkd"}]]);var eo=A("User",[["path",{d:"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2",key:"975kel"}],["circle",{cx:"12",cy:"7",r:"4",key:"17ys0d"}]]);var to=A("Wifi",[["path",{d:"M12 20h.01",key:"zekei9"}],["path",{d:"M2 8.82a15 15 0 0 1 20 0",key:"dnpr2z"}],["path",{d:"M5 12.859a10 10 0 0 1 14 0",key:"1x1e6c"}],["path",{d:"M8.5 16.429a5 5 0 0 1 7 0",key:"1bycff"}]]);var ao=A("X",[["path",{d:"M18 6 6 18",key:"1bl5f8"}],["path",{d:"m6 6 12 12",key:"d8bk6v"}]]);var no=A("Zap",[["path",{d:"M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z",key:"1xq2db"}]]);it();var Yc=document.createElement("style");Yc.textContent=`/* Stageshow kit: the stage. Tokens, the looks (theme, palette,
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
`;document.head.appendChild(Jc);it();var q0=Symbol.for("react.element"),W0=Symbol.for("react.fragment"),V0=Object.prototype.hasOwnProperty,G0=_n.ReactCurrentOwner,j0={key:!0,ref:!0,__self:!0,__source:!0};function ep(e,t,a){var n,r={},o=null,s=null;a!==void 0&&(o=""+a),t.key!==void 0&&(o=""+t.key),t.ref!==void 0&&(s=t.ref);for(n in t)V0.call(t,n)&&!j0.hasOwnProperty(n)&&(r[n]=t[n]);if(e&&e.defaultProps)for(n in t=e.defaultProps,t)r[n]===void 0&&(r[n]=t[n]);return{$$typeof:q0,type:e,key:o,ref:s,props:r,_owner:G0.current}}var Tt=W0,i=ep,v=ep;var $0={cmd:"⌘",shift:"⇧",alt:"⌥",option:"⌥",ctrl:"⌃",enter:"↵",return:"↵",esc:"esc",tab:"⇥",up:"↑",down:"↓",left:"←",right:"→",backspace:"⌫"},tp=(e)=>e.split("+").map((t)=>$0[t.trim().toLowerCase()]??t.trim().toUpperCase());function ap({rows:e,at:t}){return i(Tt,{children:e.map((a)=>a&&i("div",{className:"ss-keys","data-show":a.show,"data-at":t,"aria-hidden":!0,children:a.caps.map((n,r)=>i("kbd",{className:"ss-key","data-down":a.down,children:n},r))},a.id))})}var zs={x:0,y:0,width:0,height:0},Ts=(e)=>typeof e==="string"?e:("at"in e)?e.at:null;var np=(e,t)=>e?.offsetWidth&&e.getBoundingClientRect().width/e.offsetWidth||t||1;function Rs(e,t){let a=e.getBoundingClientRect();return{left:a.left,top:a.top,scale:e.offsetWidth&&a.width/e.offsetWidth||t||1,borderX:e.clientLeft,borderY:e.clientTop}}function Oa(e,t,a,n=Rs(e,a)){let r=t.getBoundingClientRect(),{scale:o}=n;return{x:(r.left-n.left)/o-n.borderX,y:(r.top-n.top)/o-n.borderY,width:r.width/o,height:r.height/o}}function rp(e,t,a,n=Rs(e,a)){let r=Oa(e,t,a,n),o=getComputedStyle(t),s=o.transform,l=s&&s!=="none"?s.match(/^matrix\(([^)]+)\)$/):null;if(!l)return r;let[u,c,m,g,h,w]=l[1].split(",").map(Number);if(c||m||h||w||!u||!g)return r;let x=r.width/u,k=r.height/g,[B,f]=o.transformOrigin.split(" ").map(parseFloat);return{x:r.x-B*(1-u),y:r.y-f*(1-g),width:x,height:k}}var K0=(e)=>{let t=getComputedStyle(e);return t.transform!=="none"||t.translate&&t.translate!=="none"||t.scale&&t.scale!=="none"||t.rotate&&t.rotate!=="none"};function op(e,t){let a=!0;for(let s=t;s&&s!==e;s=s.parentElement)if(K0(s)){a=!1;break}if(a)return Oa(e,t,1);let n=0,r=0,o=t;while(o&&o!==e){n+=o.offsetLeft,r+=o.offsetTop;let s=o.offsetParent;if(!s||!e.contains(s))break;if(o=s,o!==e)n+=o.clientLeft-o.scrollLeft,r+=o.clientTop-o.scrollTop}return{x:n,y:r,width:t.offsetWidth,height:t.offsetHeight}}function hi(e,t){let a=Object.keys(e);if(a.length!==Object.keys(t).length)return!1;return a.every((n)=>{let r=e[n],o=t[n];return o&&Math.abs(r.x-o.x)<0.5&&Math.abs(r.y-o.y)<0.5&&Math.abs(r.width-o.width)<0.5&&Math.abs(r.height-o.height)<0.5})}function Fs(e){let t=e.parentElement;if(!t?.classList.contains("ss-scroller"))return;let{clientHeight:a,scrollHeight:n}=e,r=n>a?Math.max(24,a/n*a):0,o=n>a?e.scrollTop/(n-a)*(a-r):0;t.style.setProperty("--ss-thumb-h",`${r}px`),t.style.setProperty("--ss-thumb-y",`${o}px`)}var X0={house:[0.65,0,0.1,1],through:[0.8,0,0.1,1],settle:[0.05,0.85,0.3,1],enter:[0.1,0.8,0.3,0.95],trip:[0.78,0,0.17,1],camera:[0.45,0,0.1,1]};function sp(e){let[t,a,n,r]=typeof e==="string"?X0[e]:e,o=3*t,s=3*(n-t)-o,l=1-o-s,u=3*a,c=3*(r-a)-u,m=1-u-c,g=(w)=>((l*w+s)*w+o)*w,h=(w)=>(3*l*w+2*s)*w+o;return(w)=>{if(w<=0)return 0;if(w>=1)return 1;let x=w;for(let k=0;k<8;k++){let B=h(x);if(Math.abs(B)<0.000001)break;let f=x-(g(x)-w)/B;if(f<0||f>1)break;x=f}if(Math.abs(g(x)-w)>0.000001){let k=0,B=1;for(let f=0;f<40;f++)if(x=(k+B)/2,g(x)<w)k=x;else B=x}return((m*x+c)*x+u)*x}}function gi(){try{return!1}catch{return!0}}function pa(e){if(gi())console.warn(`[stageshow] ${e}`)}var ma=(e,t,a)=>Math.min(a,Math.max(t,e)),Cn=(e)=>e<0.5?4*e*e*e:1-Math.pow(-2*e+2,3)/2,lp=(e)=>{let t=Math.sin(e*12.9898)*43758.5453;return t-Math.floor(t)};var up=(e)=>{if(!e)return;window.setTimeout(()=>e.removeAttribute("data-touching"),240)};class ha extends Error{}function ip(e,t){let{rootRef:a,cursorRef:n,pos:r,hovered:o,kindRef:s,keysRef:l,dragging:u,autoUsed:c,autoRef:m,scaleRef:g,speed:h,layout:w,cursor:x,resolve:k,place:B,remeasure:f,ripple:d,setState:p,setKind:L,setKeys:I,setLastKeys:T}=t,F=sp("enter"),y=()=>{if(e.aborted)throw new ha},Q=(M,b)=>new Promise((C,P)=>{y();let _=()=>{b(O),e.removeEventListener("abort",_),P(new ha)},O=M(()=>{if(e.removeEventListener("abort",_),e.aborted)P(new ha);else C()});e.addEventListener("abort",_,{once:!0})}),D=()=>Q((M)=>requestAnimationFrame(M),cancelAnimationFrame),V=(M)=>Q((b)=>setTimeout(b,M/h),clearTimeout),ot=(M)=>{let b=!0,C=()=>{if(!b)return;b=!1,e.removeEventListener("abort",C),M()};return e.addEventListener("abort",C,{once:!0}),C},Fe=async(M,b)=>{let C=performance.now(),P=M/h;for(;;){y();let _=Math.min(1,(performance.now()-C)/P);if(b(_),_===1)return;await D()}},Le=(M)=>{let b=[];for(let C=M;C&&C!==a.current;C=C.parentElement)if(C.hasAttribute("data-target"))b.push(C);return b},Lt=(M)=>{let b=a.current;if(!b)return;let C=b.querySelectorAll("[data-cursor]");if(!C.length&&!c.current)return;if(C.length)c.current=!0;let P=b.getBoundingClientRect(),_=P.width/b.offsetWidth||1,O=b.dataset.cursorBase??"pointer",X=O;b.setAttribute("data-hit","");let ue=document.elementsFromPoint(P.left+M.x*_,P.top+M.y*_);b.removeAttribute("data-hit");let E=ue.find((N)=>{if(!b.contains(N)||N.closest(".ss-cursor, .ss-keys, .ss-ripple"))return!1;if(getComputedStyle(N).pointerEvents==="none"&&!N.closest('[data-cursor], [data-target], button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="tab"]'))return!1;let ie=1;for(let j=N;j&&j!==b.parentElement;j=j.parentElement){let fe=getComputedStyle(j);if(fe.visibility==="hidden")return!1;ie*=Number(fe.opacity)}return ie>0.15});if(E){let N=E.closest('[data-cursor], button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="tab"]');if(X=N&&b.contains(N)&&N.dataset.cursor?N.dataset.cursor:O,X!==s.current)L(X);return}if(C.forEach((N)=>{let ie=N.getBoundingClientRect(),j=(ie.left-P.left)/_,fe=(ie.top-P.top)/_;if(M.x>=j&&M.x<=j+ie.width/_&&M.y>=fe&&M.y<=fe+ie.height/_)X=N.dataset.cursor}),X!==s.current)L(X)};if(m.current=Lt,!u.current)Lt(r.current);let Ge=(M)=>{if(o.current===M)return;let b=Le(M);Le(o.current).forEach((C)=>b.includes(C)||C.removeAttribute("data-hover")),b.forEach((C)=>C.setAttribute("data-hover","")),o.current=M},ye=l.current.id,Ze=0,st=(M)=>{let b=Ts(M);return b===null?null:a.current?.querySelector(`[data-target="${b}"]`)??null},ke={get signal(){return e},put(M){if(!e.aborted)p((b)=>({...b,...typeof M==="function"?M(b):M}))},async set(M){y(),ke.put(M),await D(),await D(),m.current?.(r.current),y()},wait:async(M)=>{y(),await V(M)},rect:(M,b)=>{let C=a.current,P=C?.querySelector(`[data-target="${M}"]`);if(!C||!P)return pa(`no element with data-target="${M}"`),zs;return b?.layout?op(C,P):Oa(C,P,g.current)},center:(M)=>k(M),caret(M,b){Ze++;let C=st(M),P=a.current;if(!C||!P)return 0;let _=P.getBoundingClientRect(),O=_.width/P.offsetWidth||1,X=_.left+b.x*O,ue=_.top+b.y*O,E=[],N=document.createTreeWalker(C,NodeFilter.SHOW_TEXT),ie=document.createRange(),j=0,fe=(G)=>{for(let Se=G.parentElement;Se;Se=Se===C?null:Se.parentElement){let J=getComputedStyle(Se);if(J.opacity==="0"||J.visibility==="hidden"||J.display==="none")return!0}return!1};for(let G=N.nextNode();G;G=N.nextNode()){let Se=G.textContent??"";if(fe(G))continue;for(let J=0;J<Se.length;J++){ie.setStart(G,J),ie.setEnd(G,J+1);let he=ie.getBoundingClientRect();if(he.width||he.height)E.push({left:he.left,right:he.right,mid:(he.left+he.right)/2,top:he.top,bottom:he.bottom,at:j+J})}j+=Se.length}if(!E.length)return 0;if(ue<E[0].top)return 0;if(ue>E[E.length-1].bottom)return j;let De=E[0];for(let G of E)if(Math.abs((G.top+G.bottom)/2-ue)<Math.abs((De.top+De.bottom)/2-ue))De=G;let Ce=E.filter((G)=>Math.abs(G.top-De.top)<(De.bottom-De.top)/2),Ua=Ce.find((G)=>G.mid>X);return Ua?Ua.at:Ce[Ce.length-1].at+1},async move(M,b){y();let C={...r.current},P=k(M),_=Math.hypot(P.x-C.x,P.y-C.y);if(_<0.5)return Ge(st(M));let O=Le(st(M));Ge(Le(o.current).find((j)=>O.includes(j))??null);let X=b?.duration??ma(260+_*0.9,300,650),ue=Cn,E=Math.min(_*0.08,24),N=-(P.y-C.y)/_,ie=(P.x-C.x)/_;await Fe(X,(j)=>{let fe=ue(j),De=Math.sin(Math.PI*fe)*E,Ce=b?.path?b.path(fe,C,P):{x:C.x+(P.x-C.x)*fe+N*De,y:C.y+(P.y-C.y)*fe+ie*De};if(B(Ce),Lt(Ce),b?.onMove)_s(()=>b.onMove(Ce,C,j))}),y(),Ge(st(M))},async click(M,b){if(y(),M!==void 0)await ke.move(M),await V(120);y();let C=M!==void 0?st(M):o.current,P=n.current,_=x?.style==="touch",O=ot(()=>{if(P?.removeAttribute("data-pressed"),C?.removeAttribute("data-pressed"),_)up(P)});try{if(_)P?.setAttribute("data-touching",""),await V(140),y();for(let X=0;X<(b?.double?2:1);X++){if(X)await V(70);if(y(),P?.setAttribute("data-pressed","true"),x?.ripple)d(r.current);C?.setAttribute("data-pressed",b?.right?"right":""),await V(b?.double?80:100),y(),P?.removeAttribute("data-pressed"),C?.removeAttribute("data-pressed")}}finally{O()}},async scroll(M,b,C){y();let P=st(M);if(!P)return;let _=P.scrollTop,O=typeof b==="number"?b:_;if(typeof b==="string"){let E=st(b);if(E)O=_+(E.getBoundingClientRect().top-P.getBoundingClientRect().top)/np(a.current,g.current)-(C?.offset??0)}if(O=ma(O,0,P.scrollHeight-P.clientHeight),x){let E=Oa(a.current,P,g.current||1),N=r.current;if(!(N.x>=E.x+8&&N.x<=E.x+E.width-8&&N.y>=E.y+8&&N.y<=E.y+E.height-8))await this.move({x:E.x+E.width*0.6,y:E.y+E.height*0.55}),await this.wait(120)}let X=P.parentElement?.classList.contains("ss-scroller")?P.parentElement:null;X?.setAttribute("data-scrolling","");let ue=ot(()=>X?.removeAttribute("data-scrolling"));try{await Fe(C?.duration??ma(420+Math.abs(O-_)*1.2,500,1400),(E)=>{P.scrollTop=_+(O-_)*Cn(E),P.toggleAttribute("data-scrolled",P.scrollTop>0.5),Fs(P)}),y()}finally{ue()}f(),m.current?.(r.current)},async snap(M,b){y();let C=b?a.current?.querySelector(`[data-target="${b}"]`):a.current;C?.setAttribute("data-instant","");let P=ot(()=>C?.removeAttribute("data-instant"));try{ke.put(M),await D(),await D(),y()}finally{P()}},async key(M){y();let b=tp(M),C=++ye,P=l.current;T(P.caps.length?{...P,show:!1,down:!1}:null),I({id:C,caps:b,show:!1,down:!1}),await D(),await D(),y(),I({id:C,caps:b,show:!0,down:!1}),await V(180),y(),I({id:C,caps:b,show:!0,down:!0}),await V(140),y(),I({id:C,caps:b,show:!0,down:!1}),V(600).then(()=>{if(ye===C&&!e.aborted)I({id:C,caps:b,show:!1,down:!1})},(_)=>{if(!(_ instanceof ha))console.error("[stageshow] script error",_)})},async stagger(M,b,C=60){await Promise.all(M.map(async(P,_)=>{if(_)await V(C*_);y(),await b(P,_)}))},mark(M){if(!e.aborted)a.current?.setAttribute("data-mark",M)},async cursor(M){y(),L(M),await D()},async type(M,b,C){let P=C?.interval??35;for(let _=0;_<=b.length;_++)y(),p((O)=>({...O,[M]:b.slice(0,_)})),await V(P*(0.7+0.6*lp(_)))},place(M){if(e.aborted)return;let b=k(M);B(b),m.current?.(b)},async enter(M,b){y();let C=k(M),P=a.current,_={x:0,y:0,w:P.offsetWidth,h:P.offsetHeight},O=40,X=[C.x-_.x,_.x+_.w-C.x,C.y-_.y,_.y+_.h-C.y],ue=X.indexOf(Math.min(...X)),E=ue===0?{x:_.x-O,y:C.y+_.h*0.12}:ue===1?{x:_.x+_.w+O*0.4,y:C.y+_.h*0.12}:ue===2?{x:C.x-_.w*0.06,y:_.y-O}:{x:C.x+_.w*0.06,y:_.y+_.h+O*0.4};B(E),Ge(null),await Fe(b?.duration??700,(N)=>{let ie=F(N),j={x:E.x+(C.x-E.x)*ie,y:E.y+(C.y-E.y)*ie};B(j),Lt(j)}),y(),Ge(st(M))},async drag(M,b,C){y();let P={...r.current},_=k(M),O=Math.hypot(_.x-P.x,_.y-P.y);Ge(null);let X=s.current,ue=X==="ibeam"||X==="crosshair",E=!ue&&C?.cursor!=="preserve",N=x?.style==="touch",ie=(G)=>G<0.25?G*G/0.5*1.1428571428571428:(G-0.125)*1.1428571428571428;if(N)n.current?.setAttribute("data-touching",""),await V(140),y();let j=N?n.current?.querySelector(".ss-cursor__streak")??null:null,fe=[],De=(G)=>{if(fe.unshift({...G}),fe.length>9)fe.pop();let Se=fe[fe.length-1],J=G.x-Se.x,he=G.y-Se.y,Ha=Math.min(Math.hypot(J,he),100);if(!j)return;j.style.width=`${Ha}px`,j.style.left=`${-Ha}px`,j.style.transform=`rotate(${Math.atan2(he,J)}rad)`};u.current=!0;let Ce=n.current,Ua=ot(()=>{if(u.current=!1,Ce?.removeAttribute("data-pressed"),Ce?.removeAttribute("data-swiping"),N)up(Ce)});try{if(Ce?.setAttribute("data-pressed","true"),await V(N?170:60),N){if(j)j.style.width="0px";Ce?.setAttribute("data-swiping","")}if(y(),E&&!N)L("grab");if(!N)await V(70);y(),Ce?.removeAttribute("data-pressed");let G=ue?0:Math.min(O*0.06,18),Se=O?-(_.y-P.y)/O:0,J=O?(_.x-P.x)/O:0,he=ue&&Math.abs(_.y-P.y)>6;if(he&&_.y>P.y&&_.x<P.x-2)pa("a text selection that ends left of where it starts overshoots and shrinks back; select text that starts a line, or fits on one");let Ha=Ze;if(await Fe(N?C?.duration??ma(180+O*0.5,240,300):C?.duration??ma(360+O*1.1,450,900),(Sn)=>{let yt=N?ie(Sn):Cn(Sn),qa=Math.sin(Math.PI*yt)*G,uo=he?1-(1-yt)*(1-yt):yt,io=he?yt*yt:yt,Wa=C?.path?.(yt,P,_)??{x:P.x+(_.x-P.x)*io+Se*qa,y:P.y+(_.y-P.y)*uo+J*qa};if(_s(()=>b?.(Wa,P,Sn)),B(Wa),N)De(Wa)}),ue&&b&&Ze===Ha)pa("selection drift: a text selection drag never read a.caret(), so the highlight is not under the I-beam; set it from a.caret(name, at) in onMove");if(y(),E&&!N)L(X==="grab"?"pointer":X)}finally{Ua()}m.current?.(_)},layout:w};for(let M of Object.keys(ke)){let b=ke[M];if(typeof b!=="function")continue;ke[M]=(...C)=>{let P=b.apply(ke,C);if(P instanceof Promise)P.catch((_)=>{if(!(_ instanceof ha))console.error("[stageshow] script error",_)});return P}}return ke}function dp(e,t,a,n){let r=Object.keys(t).filter((o)=>JSON.stringify(e[o])!==JSON.stringify(t[o]));if(r.length)pa(`loop seam: state still differs from initial at the end of the script (${r.join(", ")})`);if(n&&Math.hypot(a.x-n.x,a.y-n.y)>1)pa("loop seam: cursor does not end where it starts")}function cp(){return i("svg",{height:"24",width:"24",viewBox:"0 0 32 32",fill:"none",children:v("g",{transform:"translate(10 7)",children:[i("path",{d:"m6.148 18.473 1.863-1.003 1.615-.839-2.568-4.816h4.332l-11.379-11.408v16.015l3.316-3.221z",fill:"#fff"}),i("path",{d:"m6.431 17 1.765-.941-2.775-5.202h3.604l-8.025-8.043v11.188l2.53-2.442z",fill:"#000"})]})})}function pp(){return v("svg",{width:"10",height:"16",viewBox:"0 0 10 16",fill:"none",overflow:"visible",children:[i("path",{d:"M3 1H7M3 15H7M5 1V15",style:{stroke:"var(--ss-cursor-edge, #fff)"},strokeWidth:"2.6",strokeLinecap:"round"}),i("path",{d:"M3 1H7M3 15H7M5 1V15",style:{stroke:"var(--ss-cursor-line, #000)"},strokeWidth:"1",strokeLinecap:"round"})]})}function mp(){return v("svg",{width:"17",height:"17",viewBox:"0 0 17 17",fill:"none",overflow:"visible",children:[i("path",{d:"M8.5 0V17M0 8.5H17",style:{stroke:"var(--ss-cursor-edge, #fff)"},strokeWidth:"2.6"}),i("path",{d:"M8.5 0V17M0 8.5H17",style:{stroke:"var(--ss-cursor-line, #000)"},strokeWidth:"1"})]})}function hp(){return v("svg",{width:"26",height:"26",viewBox:"0 0 32 32",fill:"none",children:[i("path",{d:"M10.6 6a1.7 1.7 0 0 1 3.4 0v6.6a1.3 1.3 0 0 1 2.6 0v.7a1.3 1.3 0 0 1 2.6 0v.7a1.3 1.3 0 0 1 2.6 0V19c0 3.1-2 5.6-5 5.6h-2.6c-2 0-3.3-.9-4.4-2.4l-3.1-4.1c-.6-.9-.4-2 .5-2.5.8-.4 1.7-.2 2.3.5l1.1 1.4V6Z",fill:"#fff",stroke:"#000",strokeWidth:"1.1",strokeLinejoin:"round"}),i("path",{d:"M14 12.6v3.6M16.6 13.3v3M19.2 14v2.6",stroke:"#000",strokeWidth:"1",strokeLinecap:"round"})]})}function gp(){return i("svg",{width:"26",height:"26",viewBox:"0 0 32 32",fill:"none",children:v("g",{transform:"translate(7 6)",children:[i("path",{d:"m4.5557 8.5742c-.098-.375-.196-.847-.406-1.552-.167-.557-.342-.859-.47-1.233-.155-.455-.303-.721-.496-1.181-.139-.329-.364-1.048-.457-1.44-.119-.509.033-.924.244-1.206.253-.339.962-.49 1.357-.351.371.13.744.512.916.788.288.46.357.632.717 1.542.393.992.564 1.918.611 2.231l.085.452c-.001-.04-.043-1.122-.044-1.162-.035-1.029-.06-1.823-.038-2.939.002-.126.064-.587.084-.715.078-.5.305-.8.673-.979.412-.201.926-.215 1.401-.017.423.173.626.55.687 1.022.014.109.094.987.093 1.107-.013 1.025.006 1.641.015 2.174.004.231.003 1.625.017 1.469.061-.656.094-3.189.344-3.942.144-.433.405-.746.794-.929.431-.203 1.113-.07 1.404.243.285.305.446.692.482 1.153.032.405-.019.897-.02 1.245 0 .867-.021 1.324-.037 2.121-.001.038-.015.298.023.182.094-.28.188-.542.266-.745.049-.125.241-.614.359-.859.114-.234.211-.369.415-.688.2-.313.415-.448.668-.561.54-.235 1.109.112 1.301.591.086.215.009.713-.028 1.105-.061.647-.254 1.306-.352 1.648-.128.447-.274 1.235-.34 1.601-.072.394-.234 1.382-.359 1.82-.086.301-.371.978-.652 1.384 0 0-1.074 1.25-1.192 1.812-.117.563-.078.567-.101.965-.024.399.121.923.121.923s-.802.104-1.234.034c-.391-.062-.875-.841-1-1.078-.172-.328-.539-.265-.682-.023-.225.383-.709 1.07-1.051 1.113-.668.084-2.054.03-3.139.02 0 0 .185-1.011-.227-1.358-.305-.26-.83-.784-1.144-1.06l-.832-.921c-.284-.36-.629-1.093-1.243-1.985-.348-.504-1.027-1.085-1.284-1.579-.223-.425-.331-.954-.19-1.325.225-.594.675-.897 1.362-.832.519.05.848.206 1.238.537.225.19.573.534.75.748.163.195.203.276.377.509.23.307.302.459.214.121",fill:"#fff"}),v("g",{stroke:"#000",strokeLinecap:"round",strokeWidth:".75",children:[i("path",{d:"m4.5557 8.5742c-.098-.375-.196-.847-.406-1.552-.167-.557-.342-.859-.47-1.233-.155-.455-.303-.721-.496-1.181-.139-.329-.364-1.048-.457-1.44-.119-.509.033-.924.244-1.206.253-.339.962-.49 1.357-.351.371.13.744.512.916.788.288.46.357.632.717 1.542.393.992.564 1.918.611 2.231l.085.452c-.001-.04-.043-1.122-.044-1.162-.035-1.029-.06-1.823-.038-2.939.002-.126.064-.587.084-.715.078-.5.305-.8.673-.979.412-.201.926-.215 1.401-.017.423.173.626.55.687 1.022.014.109.094.987.093 1.107-.013 1.025.006 1.641.015 2.174.004.231.003 1.625.017 1.469.061-.656.094-3.189.344-3.942.144-.433.405-.746.794-.929.431-.203 1.113-.07 1.404.243.285.305.446.692.482 1.153.032.405-.019.897-.02 1.245 0 .867-.021 1.324-.037 2.121-.001.038-.015.298.023.182.094-.28.188-.542.266-.745.049-.125.241-.614.359-.859.114-.234.211-.369.415-.688.2-.313.415-.448.668-.561.54-.235 1.109.112 1.301.591.086.215.009.713-.028 1.105-.061.647-.254 1.306-.352 1.648-.128.447-.274 1.235-.34 1.601-.072.394-.234 1.382-.359 1.82-.086.301-.371.978-.652 1.384 0 0-1.074 1.25-1.192 1.812-.117.563-.078.567-.101.965-.024.399.121.923.121.923s-.802.104-1.234.034c-.391-.062-.875-.841-1-1.078-.172-.328-.539-.265-.682-.023-.225.383-.709 1.07-1.051 1.113-.668.084-2.054.03-3.139.02 0 0 .185-1.011-.227-1.358-.305-.26-.83-.784-1.144-1.06l-.832-.921c-.284-.36-.629-1.093-1.243-1.985-.348-.504-1.027-1.085-1.284-1.579-.223-.425-.331-.954-.19-1.325.225-.594.675-.897 1.362-.832.519.05.848.206 1.238.537.225.19.573.534.75.748.163.195.203.276.377.509.23.307.302.459.214.121",strokeLinejoin:"round"}),i("path",{d:"m11.566 12.734v-3.459"}),i("path",{d:"m9.551 12.746-.016-3.473"}),i("path",{d:"m7.555 9.305.021 3.426"})]})]})})}function xp(){return i("svg",{width:"30",height:"30",viewBox:"0 0 32 32",fill:"none",children:v("g",{transform:"translate(8 9)",children:[i("path",{d:"m3.44281398 1.68449726c-.74326136.27630142-1.05584685.8131257-1.07636853 1.38003696-.01344897.37336893.06665513.72649286.23114214 1.18694303-.02596219-.07267623.09676488.29282004.12116236.37362273.05052942.16918921-.4865367-.05865774-.81377307.00741883-.36363321.07113868-.84783757.38332307-1.10006887.79754775-.29643467.48542737-.3109609 1.04368567-.08235979 2.04824266.12491868.54736183.36572145 1.00836814.71076689 1.44594879.15329951.1944118.5713628.64726015.60307236.6875974l.84854343.94062339c.15080214.1358526.25794954.2361946.57590427.5380259.3147558.2987762.4647038.4380078.60308951.555976.05846214.0492474.10784267.1797116.12740685.3736249.01609788.1595565.01049553.3375341-.0090192.5090254-.00674888.0593077-.01325791.1020883-.01698742.1224696-.04189161.228932.13269563.4403386.36541902.4424835.21585671.0019894.38528595.0046546.82216479.0123538.09483476.0016698.09483476.0016698.18993053.0033129 1.16876447.0200186 1.75308289.0147904 2.17807912-.0385723.45429894-.0572869.92650915-.6110188 1.32698393-1.2957591.34289141.6108338.81859723 1.2057867 1.2995685 1.2820532.1510118.0244148.3353555.0322555.548787.0275887.1606725-.0035131.3307029-.0140241.5021961-.0293376.1276907-.0114022.2293359-.0228648.29003-.0307451.2258836-.0293282.373669-.251611.3133108-.4712481-.0130351-.0474332-.0339838-.1345011-.0551094-.2441635-.0245945-.1276687-.0423383-.2523857-.0503381-.365988-.0050217-.0713101-.0059948-.1359317-.0027687-.1918983.0059157-.0980798.0077938-.1530073.0108033-.281125.0010795-.0448938.0010795-.0448938.0024606-.0845172.0054208-.1364475.0233824-.2649146.0815132-.544638.0250088-.1201275.1473169-.352189.3398902-.639435.0571394-.0852302.1195783-.1742239.1864664-.26609712.1272143-.17473362.2641361-.35131772.4011075-.52030772.082051-.10123129.145482-.17695689.1808122-.21807676.2967593-.42378347.612817-1.11823437.7291396-1.52536348.1117407-.39153936.202351-1.12501196.254373-1.81690429.029923-.39968605.0410555-.72381216.0410555-1.23011613.0000742-.09758414.0000742-.09758414.0002975-.17670236.0003569-.11115478.0003569-.11115478.000115-.20711835-.0008934-.15683883-.0055282-.31323355-.0207085-.69507578-.0313109-.81293139-.4771727-1.33911388-1.1344906-1.44058831-.559108-.08631314-1.0586051.08188477-1.2779293.31625977-.0755526.08073733.0036753-.2781823-.2159489-.62316278-.1644465-.25841586-.593184-.58905957-.9209287-.65355552-.335487-.06535532-.73539548-.05811715-1.1017193.00667481-.32093157.05742909-.68608434.33741751-.87176225.64688068-.12411885.20686477.03884667-.00592296-.09368743-.23401341-.18231052-.31422641-.60754287-.59486422-1.01411454-.67799709-.34643562-.07139428-.74182572-.04452925-1.09945614.0633873-.43336319.1291117-1.01795827.61460976-.94899189 1.15552627-.34375-.54091651-1.25026717-.691379-1.97906097-.42111797z",fill:"#000"}),i("path",{d:"m7.31951013 1.62138197c.20710357.04234751.44724204.20083012.51632974.31990811.08404358.1446387.15562749.36413806.21048667.6366124.02933373.14569467.12179446 1.2125285.29383112 1.32370243.41279229.04533731.41279229.04533731.52658055-.12364345.03545705-.07383858.03545705-.07383858.04226523-.1029106.01416796-.06009544.02463332-.12677987.0351322-.21754028l.00854738-.07915386.00047673-.00942804.00327525-.03167185c.01085148-.11424313.04184125-.4312127.05388392-.53034902.03788792-.31189663.08766449-.52757784.13944093-.6138719.0713024-.11883734.31942298-.28274442.43149612-.30279961.2804398-.04960082.58940103-.05519288.82623993-.00905543.1084394.02134018.3709471.22378689.432331.32024744.1291079.20279957.2524316.84889766.3225486 1.4970065-.0102194.04624251-.0102194.04624251.1640069.28984194.5843296-.06677889.5843296-.06677889.5703629-.17490247.0159511-.03856429.0284824-.08294031.045969-.15118961.0423876-.16089067.0697594-.25204451.111066-.35549917.0288558-.07227096.0592914-.13391873.0904889-.18278042.1209187-.19031132.4335712-.319392.7077174-.27707028.2943447.04543991.4816904.26653537.4994912.72869815.0148821.37434892.0193146.5239164.0201469.6700184l-.0004247.37954865c0 .48831141-.0104951.79388164-.0389535 1.17400348-.0480918.63962116-.1348512 1.34192123-.227649 1.66708484-.0946325.33121345-.3766371.95084197-.6003915 1.27298482-.0161892.01580846-.0841508.09694273-.1710333.20413492-.1445842.17838247-.2892181.36491271-.4247891.5511244-.0723398.09936149-.1402862.19620479-.2030964.2898938-.2440054.36396314-.400553.66098894-.4512157.90434304-.0659304.3172546-.0893838.4850003-.0966379.6675968-.0017072.0490782-.0017072.0490782-.002845.096677-.0028064.119476-.004437.1671639-.0097087.2545848-.0052654.091322-.0038193.187354.00332.2887353.0103318.1467182.1058713.3478531.1058713.3478531s-.2321503-.0119819-.3742084-.0088758c-.1718098.0037567-.3147843-.0023244-.4138162-.0183342-.1440353-.0228411-.53014068-.5057331-.7278511-.8821737-.30227042-.5764228-1.03604858-.5484427-1.33684295-.0394061-.26854779.4591613-.65918083.9172326-.7740684.9317199-.37404082.0469647-.94643778.0520862-2.07160079.0328144-.09480875-.0016381-.46003446-.0128683-.64600494-.0157445-.18597048-.0028763.05008807-.1790283.02786486-.399297-.03726222-.36933-.15125405-.6704984-.38877094-.8705429-.12241569-.1043631-.26774964-.2393104-.56509654-.5215613-.33323493-.3163366-.44236499-.4185353-.57290215-.533275l-.80130455-.89071892c-.03955779-.05174211-.45812831-.5051399-.5872217-.6688539-.28069963-.35597842-.47062947-.71959073-.56844755-1.14820437-.18921973-.83150113-.1793328-1.21146622-.00855589-1.49112273.13743587-.2257023.43815377-.4195862.60596039-.45241793.17165981-.03465512.55153059-.01648617.62179422.02229321.09902279.05401056.13357243.07300285.16379074.09097645.03572494.02124891.05965747.03799198.08182912.05708809.03426437.02951139.07235014.07170412.12420211.14044502.03611591.04821025.07806642.1053997.1423779.19304882.06054643.0816627.09183576.12069421.13369221.1590035.28038907.25662728.68391532.03238058.65052057-.32606956-.00567036-.06086415-.02203766-.12694598-.05458621-.23708502-.04356824-.15021272.00433013-.05284275-.26002629-.56642281-.08720664-.16942124-.13955864-.28835362-.17428227-.4046158l-.03412852-.10219113c-.03838756-.11059767-.09558223-.26854489-.12612861-.35199347l-.02009957-.05467087.002.008-.05974804-.17751191c-.09232236-.28807194-.13413567-.51358087-.12645475-.72681781.01040781-.28751553.16037753-.54506871.58790983-.70400047.40142488-.1488616 1.07786076.00117106 1.20581167.27856864.04319814.09369738.08927466.21199471.13900415.35457792l.03930997.11680217c.05539717.16759437.13470873.41493582.13860471.42816881.02724222.08344874.0471839.13860719.06943813.18441246.00217869.06301886.00217869.06301886.35429398.23177937.41699479-.29154152.41699479-.29154152.38019201-.37525838.00571063-.08773482.00758408-.17356287.00965287-.37317647.00242546-.23402898.00423842-.33154773.00994479-.45966208.01316411-.29554918.0437926-.51142116.09291227-.63864415.09160418-.23801371.25279279-.40993649.4432431-.46667832.24458613-.07380253.51465245-.09215236.73323569-.04710649zm1.21356228 4.27672201c-.20710459.00095412-.37422255.16961903-.37326843.37672361l.016 3.473c.00095412.20710459.16961903.37422251.37672361.37326841.20710459-.0009541.37422255-.16961901.37326843-.37672359l-.016-3.473c-.00095412-.20710459-.16961903-.37422255-.37672361-.37326843zm2.03332759.00229602c-.2071068 0-.375.16789322-.375.375v3.459c0 .20710678.1678932.375.375.375s.375-.16789322.375-.375v-3.459c0-.20710678-.1678932-.375-.375-.375zm-4.01399856.02930704c-.20710289.00126946-.37396385.17018863-.3726944.37729152l.021 3.426c.00126946.20710289.17018863.37396384.37729152.37269444.20710289-.0012695.37396385-.17018867.3726944-.37729156l-.021-3.426c-.00126946-.20710289-.17018863-.37396385-.37729152-.3726944z",fill:"#fff"})]})})}function wp(){return v("svg",{width:"16",height:"16",viewBox:"0 0 20 20",fill:"none",xmlns:"http://www.w3.org/2000/svg",children:[i("circle",{cx:"10",cy:"10",r:"8",stroke:"rgba(0,0,0,0.15)",strokeWidth:"2"}),i("path",{d:"M10 2A8 8 0 0 1 18 10",stroke:"black",strokeWidth:"2",strokeLinecap:"round"})]})}var fp="M0-8.4 2.55-3.65H-2.55ZM0 8.4 2.55 3.65H-2.55Z";function Ds({turn:e}){return i("svg",{width:"21",height:"21",viewBox:"-14 -14 28 28",overflow:"visible",children:v("g",{transform:`rotate(${e})`,strokeLinejoin:"round",children:[i("path",{d:fp,style:{fill:"var(--ss-cursor-edge, #fff)",stroke:"var(--ss-cursor-edge, #fff)"},strokeWidth:"3.2"}),i("path",{d:fp,style:{fill:"var(--ss-cursor-line, #000)",stroke:"var(--ss-cursor-line, #000)"},strokeWidth:"1.2"})]})})}var Lp=()=>i(Ds,{turn:0}),yp=()=>i(Ds,{turn:90}),vp=()=>i(Ds,{turn:-45}),Ip=()=>i(Ds,{turn:45});var kp=document.createElement("style");kp.textContent=`/* The cursor (cursor.tsx): glyphs, the five styles, press, idle, ripples. */

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
`;document.head.appendChild(kp);var Cp={pointer:cp,ibeam:pp,crosshair:mp,hand:hp,open:gp,grab:xp,wait:wp,"resize-ns":Lp,"resize-ew":yp,"resize-nwse":vp,"resize-nesw":Ip},Z0={pointer:{x:7.5,y:5.25},ibeam:{x:5,y:8},crosshair:{x:8.5,y:8.5},hand:{x:9.75,y:3.25},open:{x:11.7,y:10.4},grab:{x:12,y:12},wait:{x:8,y:8},"resize-ns":{x:10.5,y:10.5},"resize-ew":{x:10.5,y:10.5},"resize-nwse":{x:10.5,y:10.5},"resize-nesw":{x:10.5,y:10.5}},Q0={x:4,y:3};function Y0(){return i("svg",{width:"22",height:"22",viewBox:"0 0 22 22",className:"ss-cursor__arrow","aria-hidden":!0,children:i("path",{d:"M4 3 18.5 9.6 11.8 11.8 9.6 18.5Z"})})}function Sp({cursorRef:e,style:t="real",kind:a}){return v("div",{ref:e,className:"ss-cursor","data-style":t,"data-kind":a,"aria-hidden":!0,children:[t==="touch"&&i("span",{className:"ss-cursor__streak"}),v("div",{className:"ss-cursor__press",children:[(t==="circle"||t==="touch")&&i("span",{className:"ss-cursor__dot"}),t!=="circle"&&t!=="touch"&&Object.keys(Cp).map((n)=>{let r=t==="arrow";if(r&&n!=="pointer"&&n!=="ibeam")return null;let o=r&&n==="pointer"?Y0:Cp[n],s=r&&n==="pointer"?Q0:Z0[n];return i("div",{className:"ss-cursor__glyph","data-glyph":n,"data-active":n===(r&&a!=="ibeam"?"pointer":a),style:{marginLeft:-s.x,marginTop:-s.y,transformOrigin:`${s.x}px ${s.y}px`},children:i(o,{})},n)})]})]})}function bp(e,t){let a=document.createElement("span");a.className="ss-ripple",a.style.left=`${t.x}px`,a.style.top=`${t.y}px`,e.appendChild(a),a.addEventListener("animationend",()=>a.remove())}it();var xi=An({theme:"light",palette:"accent",fidelity:"standard",layout:"wide"}),wi=()=>Tn(xi);it();var Li=An(!1);function Pp(){let e=Tn(Li),[t,a]=pe(!1);return Ct(()=>{let n=window.matchMedia("(prefers-reduced-motion: reduce)"),r=()=>a(n.matches);return r(),n.addEventListener("change",r),()=>n.removeEventListener("change",r)},[]),e||t}var ga={now:()=>performance.now(),raf:(e)=>requestAnimationFrame(e),cancelRaf:(e)=>cancelAnimationFrame(e),layoutRaf:(e)=>ga.recording?.requestLayoutFrame(e)??requestAnimationFrame(e),cancelLayoutRaf:(e)=>{let t=ga.recording;if(t)t.cancelLayoutFrame(e);else cancelAnimationFrame(e)},timeout:(e,t)=>window.setTimeout(e,t),clearTimeout:(e)=>window.clearTimeout(e),get recording(){return typeof window>"u"?null:window.__stageshow?.clock??null}};var J0={};function Bs({width:e,height:t,initial:a=J0,script:n,poster:r,cursor:o,hover:s,play:l="loop",compact:u,keys:c="bottom",palette:m="accent",greys:g,fidelity:h="standard",specimen:w,unframed:x,speed:k=1,accent:B,tokens:f,ground:d,fill:p=!1,theme:L="light",className:I,children:T}){let F=l==="hover"&&typeof window<"u"&&window.matchMedia("(hover: none)").matches?"once":l,[y,Q]=pe("wide"),D=Z(y);D.current=y;let V=()=>{let z=o.at;return typeof z==="object"&&"wide"in z?z[D.current]:z},[ot,Fe]=pe(!1),Le=y==="compact"&&u?u.width:e,Lt=y==="compact"&&u?u.height:t,Ge=Z(null),ye=Z(null),Ze=Z(null),st=Pp(),ke=!n||st,[M,b]=pe(()=>ke&&r?r:a),C=Z(M);C.current=M;let[P,_]=pe(1),O=Z(1);O.current=P;let X=typeof window>"u"?{}:window.__stageshow??{},ue=k/(X.slow??1),E=X.theme??L,[N,ie]=pe(o?.kind??"pointer"),j=(z)=>{let U=ye.current;if(!U||st)return;bp(U,z)},fe=Z(N);fe.current=N;let[De,Ce]=pe({id:0,caps:[],show:!1,down:!1}),[Ua,G]=pe(null),Se=Z(De);Se.current=De;let J=Z({x:0,y:0}),he=Z(null),[Ha,Sn]=pe(0),yt=Z(!1),qa=Z(!1),uo=Z(null);ut(()=>{let z=Ge.current;if(!z)return;let U=()=>{let ee=z.clientWidth,vt=!!z.parentElement?.closest("[data-ss-wide]"),It=u&&!vt&&ee<u.below?"compact":"wide";Q(It);let Rt=p||!!z.parentElement?.closest("[data-ss-fill]");Fe(Rt);let kt=It==="compact"?u.width:e,lt=Math.min(Rt?2:1,ee/kt);_(lt),Sn(Math.max(0,(ee-kt*lt)/2))};U();let W=new ResizeObserver(U);W.observe(z);let H=new MutationObserver(U);for(let ee=z.parentElement;ee;ee=ee.parentElement)H.observe(ee,{attributes:!0,attributeFilter:["data-ss-wide","data-ss-fill"]});return()=>{W.disconnect(),H.disconnect()}},[e,u?.below,u?.width,p]);let[io,Wa]=pe({}),Us=Dt(()=>{let z=ye.current;if(!z)return{};let U={},W=z.querySelectorAll("[data-target]");if(!W.length)return U;let H=Rs(z,O.current);return W.forEach((ee)=>{U[ee.dataset.target]=rp(z,ee,O.current,H)}),U},[]),Hs=Z({n:0,frame:0,owed:!1}),xa=Dt(()=>{let z=Hs.current;if(!z.frame)z.frame=ga.layoutRaf(()=>{if(z.n=0,z.frame=0,!z.owed)return;z.owed=!1;let W=Us();Wa((H)=>hi(H,W)?H:W)});if(z.n>=4){z.owed=!0;return}z.n++;let U=Us();Wa((W)=>hi(W,U)?W:U)},[Us]);ut(xa),ut(()=>()=>{ga.cancelLayoutRaf(Hs.current.frame),Hs.current={n:0,frame:0,owed:!1}},[]),Ct(()=>{let z=ye.current;if(!z)return;return z.addEventListener("transitionend",xa),z.addEventListener("animationend",xa),()=>{z.removeEventListener("transitionend",xa),z.removeEventListener("animationend",xa)}},[xa]);let Xp=Dt((z)=>io[z]??zs,[io]),[Zp,Ii]=pe(!0);ut(()=>{Ii(!0);let z=!0,U=0,W=()=>{U=ga.layoutRaf(()=>{U=ga.layoutRaf(()=>z&&Ii(!1))})};if(!document.fonts||document.fonts.status==="loaded")W();else document.fonts.ready.then(()=>z&&W());return()=>{z=!1,ga.cancelLayoutRaf(U)}},[y]);let Va=Z(0),bn=Z(0),Pn=Z(!1),qs=Z(null),Ga=Dt((z)=>{if(bn.current&&!Pn.current&&Math.hypot(z.x-J.current.x,z.y-J.current.y)>0.5)Pn.current=!0,qs.current??=performance.now()-bn.current;J.current=z,Va.current=performance.now();let U=Ze.current;if(!U)return;U.style.transform=`translate(${z.x}px, ${z.y}px)`,U.removeAttribute("data-idle")},[]),wa=Dt((z)=>{if(typeof z==="object"&&z!==null&&"wide"in z)z=D.current==="compact"?z.compact:z.wide;let U=Ts(z);if(U===null)return z;let W=ye.current,H=W?.querySelector(`[data-target="${U}"]`);if(!W||!H)return pa(`no element with data-target="${U}"`),J.current;let ee=Oa(W,H,O.current),vt=typeof z==="string"?{x:0.5,y:0.5}:z;return{x:ee.x+ee.width*vt.x,y:ee.y+ee.height*vt.y}},[]);ut(()=>{if(!ke||!s)return;let z=ye.current;s.forEach((U)=>z?.querySelector(`[data-target="${U}"]`)?.setAttribute("data-hover",""))}),ut(()=>{if(o&&!bn.current)Ga(wa(V()))},[P,y]);let Ws=Z(0),La=Z(0),fo=Dt(()=>{++Ws.current,cancelAnimationFrame(La.current),La.current=0,ye.current?.removeAttribute("data-settling")},[]),Vs=Dt((z=!1)=>{fo();let U=Ws.current;if(qa.current=!1,b(a),ie(o?.kind??"pointer"),Ce((H)=>({...H,show:!1,down:!1})),G(null),ye.current?.querySelectorAll("[data-hover],[data-pressed]").forEach((H)=>{H.removeAttribute("data-hover"),H.removeAttribute("data-pressed")}),ye.current?.removeAttribute("data-mark"),ye.current?.querySelectorAll("[data-scrolled]").forEach((H)=>{H.scrollTop=0,H.removeAttribute("data-scrolled"),Fs(H)}),ye.current?.querySelectorAll("[data-scrolling]").forEach((H)=>H.removeAttribute("data-scrolling")),Ze.current?.removeAttribute("data-pressed"),uo.current=null,!o)return;if(!z){La.current=requestAnimationFrame(()=>{La.current=0,Ga(wa(V())),he.current?.(J.current)});return}let W=ye.current;W?.setAttribute("data-settling",""),La.current=requestAnimationFrame(()=>{let H={...J.current},ee=wa(V()),vt=ma(320+Math.hypot(ee.x-H.x,ee.y-H.y)*0.7,380,700),It=performance.now(),Rt=()=>{if(Ws.current!==U)return;let kt=Math.min(1,(performance.now()-It)/vt),lt=Cn(kt);if(Ga({x:H.x+(ee.x-H.x)*lt,y:H.y+(ee.y-H.y)*lt}),kt<1)La.current=requestAnimationFrame(Rt);else La.current=0,W?.removeAttribute("data-settling")};Rt()})},[y]),ki=po(()=>(z)=>ip(z,{rootRef:ye,cursorRef:Ze,pos:J,hovered:uo,kindRef:fe,keysRef:Se,dragging:qa,autoUsed:yt,autoRef:he,scaleRef:O,speed:ue,layout:y,cursor:o,resolve:wa,place:Ga,remeasure:xa,ripple:j,setState:b,setKind:ie,setKeys:Ce,setLastKeys:G}),[wa,Ga,ue,y]);Ct(()=>{let z=ye.current;if(ke||!n)return Vs(),z.removeAttribute("data-offscreen"),b(r??a),fo;Vs();let U=Ge.current,W=null,H=!1,ee=!1,vt=!1,It=o?.idle??4000,Rt=1200,kt=0,lt=0,Jp=()=>{if(window.clearInterval(kt),!o||It===!1)return;Va.current=performance.now(),kt=window.setInterval(()=>{let ce=Ze.current;if(!ce)return;let Qe=performance.now();if(!Pn.current){if(qs.current===null&&Qe-Va.current>Rt)ce.setAttribute("data-idle","");return}if(ce.hasAttribute("data-pressed")||ye.current?.querySelector("[data-hover]"))Va.current=Qe;else if(Qe-Va.current>It)ce.setAttribute("data-idle","")},150)},em=()=>{bn.current=performance.now(),Pn.current=!1,window.clearTimeout(lt);let ce=Ze.current,Qe=qs.current;if(It===!1||!ce||Qe===null||Qe<=Rt)return;ce.setAttribute("data-idle",""),lt=window.setTimeout(()=>ce.removeAttribute("data-idle"),Qe-400)},Gs=()=>{window.clearInterval(kt),window.clearTimeout(lt),bn.current=0,Ze.current?.removeAttribute("data-idle")},tm=()=>{window.clearInterval(kt),window.clearTimeout(lt);let ce=Ze.current,Qe=()=>ce?.hasAttribute("data-pressed")||z.querySelector("[data-hover]");if(!o||It===!1||!ce||ce.hasAttribute("data-idle")||Qe())return;let co=(Pn.current?It:Rt)-(performance.now()-Va.current);lt=window.setTimeout(()=>{if(!Qe())ce.setAttribute("data-idle","")},Math.max(0,co))},js=()=>{if(W||vt||!H||document.hidden)return;if(F==="hover"&&!ee)return;if(fo(),o)Ga(wa(V()));W=new AbortController;let ce=W.signal;Jp();let Qe=ki(ce);(async()=>{do{em();try{await n(Qe)}catch(co){if(co instanceof ha)return;console.error("[stageshow] script error",co),W=null,Gs();return}if(F==="loop"&&gi())dp(C.current,a,J.current,o?wa(V()):null)}while(F==="loop"&&!ce.aborted);if(F==="once"&&!ce.aborted)vt=!0,tm()})()},$s=(ce=!1)=>{if(Gs(),!W)return;if(W.abort(),W=null,!vt)Vs(ce)},Ks=()=>z.toggleAttribute("data-offscreen",!H||document.hidden);Ks();let Ci=new IntersectionObserver(([ce])=>{H=ce.isIntersecting,Ks(),H?js():$s()});Ci.observe(U);let Si=()=>{Ks(),document.hidden?$s():js()};document.addEventListener("visibilitychange",Si);let bi=()=>{ee=!0,js()},Pi=()=>{ee=!1,$s(!0)};if(F==="hover")U.addEventListener("pointerenter",bi),U.addEventListener("pointerleave",Pi);return()=>{Ci.disconnect(),document.removeEventListener("visibilitychange",Si),U.removeEventListener("pointerenter",bi),U.removeEventListener("pointerleave",Pi),Gs(),W?.abort(),W=null,he.current=null,fo()}},[ke,n,ki,F,y]),ut(()=>{if(o&&!ke&&!qa.current)he.current?.(J.current)},[M]);let Qp=po(()=>({theme:E,palette:m,fidelity:h,layout:y}),[E,m,h,y]),Yp=o&&(!n||!ke||o.still);return i("div",{ref:Ge,className:`ss-fit${I?` ${I}`:""}`,style:{maxWidth:ot?void 0:e,height:Lt*P},children:v("div",{ref:ye,className:"ss-stage","data-specimen":w||void 0,"data-unframed":x||void 0,"data-still":ke||void 0,"data-placing":Zp||void 0,"data-theme":E,"data-palette":m,"data-greys":g==="cool"?"cool":void 0,"data-fidelity":h,"data-layout":y,style:{width:Le,height:Lt,marginLeft:Ha||void 0,transform:`scale(${P})`,...f,...B?{["--ss-accent"]:B,["--ss-accent-2"]:B,["--ss-accent-soft"]:`color-mix(in srgb, ${B} 14%, transparent)`}:null},children:[d&&i("div",{className:"ss-ground","aria-hidden":!0,style:Array.isArray(d)?{["--ss-orb-1"]:d[0],["--ss-orb-2"]:d[1],...d[2]?{["--ss-orb-3"]:d[2]}:null}:void 0}),i(Li.Provider,{value:ke,children:i(xi.Provider,{value:Qp,children:T(M,Xp,y)})}),n&&i(ap,{rows:[Ua,De],at:typeof c==="string"?c:c[y]}),Yp&&i(Sp,{cursorRef:Ze,style:o.style,kind:N})]})})}var Mp=document.createElement("style");Mp.textContent=`/* Window chrome (window.tsx): browser, app and sidebar app, plus the Bar and
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
`;document.head.appendChild(Mp);function ro(){return v("span",{className:"ss-window__lights",children:[i("span",{className:"ss-window__dot"}),i("span",{className:"ss-window__dot"}),i("span",{className:"ss-window__dot"})]})}function e1(){return v("svg",{className:"ss-window__lock",width:"7",height:"8",viewBox:"0 0 7 8","aria-hidden":!0,children:[i("path",{d:"M1.5 3.3V2.4a2 2 0 0 1 4 0v.9",fill:"none",stroke:"currentColor",strokeWidth:"1.1"}),i("rect",{x:"0",y:"3.3",width:"7",height:"4.7",rx:"1.2",fill:"currentColor"})]})}function _p({back:e}){return i("svg",{className:"ss-window__chev",width:"10",height:"10",viewBox:"0 0 10 10","aria-hidden":!0,children:i("path",{d:e?"M6.5 1.5 3 5l3.5 3.5":"M3.5 1.5 7 5 3.5 8.5",fill:"none",stroke:"currentColor",strokeWidth:"1.4",strokeLinecap:"round",strokeLinejoin:"round"})})}function Ap({url:e,urlShape:t,tabs:a,nav:n,title:r,sidebar:o,sidebarWidth:s=180,sidebarStyle:l,toolbar:u,lead:c,body:m,className:g,receded:h,chrome:w,lights:x,lightsSize:k,barSize:B,children:f,...d}){let p=`ss-window ss-recede${g?` ${g}`:""}`,L=k==="large"?"large":void 0,I=B==="tall"?"tall":void 0;if(w==="terminal")return v("div",{...d,className:p,"data-chrome":"terminal","data-lights":x==="grey"?"grey":void 0,"data-lights-size":L,"data-receded":h||void 0,children:[v("div",{className:"ss-window__bar",children:[i(ro,{}),r!==void 0&&i("span",{className:"ss-term__title",children:r})]}),i("div",{...m,className:`ss-window__body ss-term${m?.className?` ${m.className}`:""}`,children:f})]});if(w==="glass"||w==="card"||w==="hairline")return v("div",{...d,className:p,"data-chrome":w,"data-lights":x==="color"||x==="white"?x:w==="glass"?"grey":void 0,"data-receded":h||void 0,children:[v("div",{className:"ss-window__bar",children:[i(ro,{}),e!==void 0&&v("span",{className:"ss-window__url",children:[w==="glass"&&i(e1,{}),i("span",{className:"ss-window__url-text",children:e})]}),i("span",{className:"ss-window__end",children:u})]}),i("div",{...m,className:`ss-window__body${m?.className?` ${m.className}`:""}`,children:f})]});let T=e!==void 0&&v(Tt,{children:[n&&v("span",{className:"ss-window__nav",children:[i(_p,{back:!0}),i(_p,{})]}),i("span",{className:"ss-window__url",children:e})]});if(o!==void 0)return v("div",{...d,className:p,"data-kind":"sidebar","data-side":l==="floating"?"floating":void 0,"data-lights":x==="grey"?"grey":void 0,"data-lights-size":L,"data-bar":I,"data-receded":h||void 0,"data-url-shape":t,children:[v("aside",{className:"ss-window__side",style:{width:s},children:[i("div",{className:"ss-window__side-top",children:i(ro,{})}),o]}),v("div",{className:"ss-window__main",children:[v("div",{className:"ss-window__bar",children:[r!==void 0&&i("span",{className:"ss-window__heading",children:r}),c,T,i("span",{className:"ss-window__spacer"}),u]}),i("div",{...m,className:`ss-window__body${m?.className?` ${m.className}`:""}`,children:f})]})]});if(a?.length)return v("div",{...d,className:p,"data-kind":"tabs","data-lights":x==="grey"?"grey":void 0,"data-lights-size":L,"data-receded":h||void 0,"data-url-shape":t,children:[v("div",{className:"ss-window__tabs",children:[i(ro,{}),a.map((F,y)=>v("span",{className:"ss-window__tab","data-active":y===0||void 0,children:[i("span",{className:"ss-window__favicon"}),i("span",{className:"ss-window__tab-label",children:F})]},y))]}),v("div",{className:"ss-window__bar",children:[T,u]}),i("div",{...m,className:`ss-window__body${m?.className?` ${m.className}`:""}`,children:f})]});return v("div",{...d,className:p,"data-receded":h||void 0,"data-url-shape":t,"data-lights":x==="grey"?"grey":void 0,"data-lights-size":L,"data-bar":I,children:[v("div",{className:"ss-window__bar",children:[i(ro,{}),T,r!==void 0&&i("span",{className:"ss-window__title","data-toolbar":u?!0:void 0,children:r}),c,e===void 0&&r===void 0&&i("span",{className:"ss-window__spacer"}),u]}),i("div",{...m,className:`ss-window__body${m?.className?` ${m.className}`:""}`,children:f})]})}it();var zp=document.createElement("style");zp.textContent=`/* Collapse */

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
`;document.head.appendChild(zp);function Ve({open:e,reveal:t="clip",from:a="above",solid:n=!1,children:r,className:o,...s}){let[l,u]=pe(!1),[c,m]=pe(!1),g=Z(null),h=Z(!0);return ut(()=>{let w=g.current?.scrollHeight??0;if(w)m(w>44);if(h.current)return void(h.current=!1);u(!0);let x=setTimeout(()=>u(!1),900);return()=>clearTimeout(x)},[e]),i("div",{...s,className:`ss-collapse${o?` ${o}`:""}`,"data-open":e||void 0,"data-reveal":t,"data-solid":n||void 0,"data-from":t==="drop"?a:void 0,"data-moving":l||void 0,"data-tall":c||void 0,onTransitionEnd:(w)=>{if(w.target===w.currentTarget&&w.propertyName==="grid-template-rows")u(!1);s.onTransitionEnd?.(w)},children:i("div",{ref:g,className:"ss-collapse__inner","data-crop":t==="clip"||void 0,children:r})})}var Tp=document.createElement("style");Tp.textContent=`/* Icon */

@layer stageshow {
  .ss-icon {
    display: block;
    flex-shrink: 0;
  }
}
`;document.head.appendChild(Tp);var Rp={check:Rr,plus:Ea,close:ao,"chevron-right":Dr,"chevron-down":Ba,search:Na,globe:Ur,external:Ar,clock:Br,archive:Mr,trash:Jr,more:ca,arrow:_r,file:Nr,user:eo,bell:Da,card:Er,bolt:no,lock:Wr,play:$r,pause:jr,faceid:Kr,wifi:to,heart:qr,star:Yr,calendar:Tr,mail:Vr,send:Xr,home:zt,gear:Zr,grip:Hr},t1={chip:"M3.5 2.5h9a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4a1.5 1.5 0 0 1 1.5-1.5zM2 6h4M2 10h4M10 6h4M10 10h4M6 2.5v11M10 2.5v11M6 8h4",contactless:"M6.8 6.2a2.5 2.5 0 0 1 0 3.6M8.5 4.5a5 5 0 0 1 0 7M10.3 2.7a7.5 7.5 0 0 1 0 10.6"},a1={bolt:"M9.6 1.2 3.2 8.9a.6.6 0 0 0 .5 1H7.4l-1 4.9a.4.4 0 0 0 .7.3l6.4-7.7a.6.6 0 0 0-.5-1H9.3l1-4.9a.4.4 0 0 0-.7-.3Z",card:"M3 3h10a1.75 1.75 0 0 1 1.75 1.75V5.6H1.25v-.85A1.75 1.75 0 0 1 3 3Zm-1.75 4.4h13.5v3.85A1.75 1.75 0 0 1 13 13H3a1.75 1.75 0 0 1-1.75-1.75Zm2.25 2.6v1h3v-1Z",bell:"M8 1.25a4.25 4.25 0 0 0-4.25 4.25v3.1l-1.3 2.1a.6.6 0 0 0 .5.9h10.1a.6.6 0 0 0 .5-.9l-1.3-2.1V5.5A4.25 4.25 0 0 0 8 1.25ZM6.2 13.1a1.9 1.9 0 0 0 3.6 0Z",user:"M8 1.5a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2Zm0 7.4c3.1 0 5.4 1.8 5.9 4.6a.7.7 0 0 1-.7.8H2.8a.7.7 0 0 1-.7-.8C2.6 10.7 4.9 8.9 8 8.9Z",clock:"M8 1.25a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5Zm-.75 3v4.2l2.9 1.75.75-1.25-2.15-1.3V4.25Z",check:"M8 1.25a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5Zm3 4.3-.95-.8-3.3 3.95-1.85-1.8-.85.9 2.8 2.75Z",lock:"M8 1.25A3.25 3.25 0 0 0 4.75 4.5v2H4.5A1.5 1.5 0 0 0 3 8v5.25a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V8a1.5 1.5 0 0 0-1.5-1.5h-.25v-2A3.25 3.25 0 0 0 8 1.25Zm-1.75 5.25v-2a1.75 1.75 0 0 1 3.5 0v2Z",play:"M4.5 2.6v10.8a.8.8 0 0 0 1.2.7l8.6-5.4a.8.8 0 0 0 0-1.4L5.7 1.9a.8.8 0 0 0-1.2.7Z",pause:"M4 2.5h2.6a.6.6 0 0 1 .6.6v9.8a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V3.1a.6.6 0 0 1 .6-.6Zm5.4 0H12a.6.6 0 0 1 .6.6v9.8a.6.6 0 0 1-.6.6H9.4a.6.6 0 0 1-.6-.6V3.1a.6.6 0 0 1 .6-.6Z",heart:"M8 14.2c-.2 0-6.6-3.7-6.6-8.4a3.6 3.6 0 0 1 6.6-2 3.6 3.6 0 0 1 6.6 2c0 4.7-6.4 8.4-6.6 8.4Z",star:"M8 1.2a.6.6 0 0 1 .55.35l1.75 3.6 3.95.55a.6.6 0 0 1 .33 1.03l-2.86 2.8.68 3.94a.6.6 0 0 1-.87.63L8 12.25 4.47 14.1a.6.6 0 0 1-.87-.63l.68-3.94-2.86-2.8a.6.6 0 0 1 .33-1.03l3.95-.55 1.75-3.6A.6.6 0 0 1 8 1.2Z",home:"M7.5 1.6a.8.8 0 0 1 1 0l5.7 4.6a.8.8 0 0 1 .3.6v6.7a1 1 0 0 1-1 1H10V10.3H6v4.2H2.5a1 1 0 0 1-1-1V6.8a.8.8 0 0 1 .3-.6Z",gear:"M6.67 2.46L7.03 0.81L8.97 0.81L9.33 2.46L10.98 3.14L12.40 2.24L13.76 3.60L12.86 5.02L13.54 6.67L15.19 7.03L15.19 8.97L13.54 9.33L12.86 10.98L13.76 12.40L12.40 13.76L10.98 12.86L9.33 13.54L8.97 15.19L7.03 15.19L6.67 13.54L5.02 12.86L3.60 13.76L2.24 12.40L3.14 10.98L2.46 9.33L0.81 8.97L0.81 7.03L2.46 6.67L3.14 5.02L2.24 3.60L3.60 2.24L5.02 3.14ZM5.60 8.00a2.40 2.40 0 1 0 4.80 0a2.40 2.40 0 1 0 -4.80 0Z",calendar:"M3.5 2h9A2 2 0 0 1 14.5 4v8.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm-.5 4.5v6a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-6ZM4.2 7.6h1.6v1.6h-1.6ZM7.2 7.6h1.6v1.6h-1.6ZM10.2 7.6h1.6v1.6h-1.6ZM4.2 10.2h1.6v1.6h-1.6ZM7.2 10.2h1.6v1.6h-1.6ZM10.2 10.2h1.6v1.6h-1.6Z",send:"M14.3 1.7a.55.55 0 0 0-.6-.12L1.75 6.4a.55.55 0 0 0 0 1.02l4.6 1.85 4.9-4.13a.2.2 0 0 1 .28.28L7.4 10.3l1.84 4.6a.55.55 0 0 0 1.02 0l4.83-11.95a.55.55 0 0 0-.12-.6Z",mail:"M2.5 3h11A1.5 1.5 0 0 1 15 4.4L8 8.9 1 4.4A1.5 1.5 0 0 1 2.5 3ZM1 6.1v5.4A1.5 1.5 0 0 0 2.5 13h11a1.5 1.5 0 0 0 1.5-1.5V6.1l-6.6 4.2a.8.8 0 0 1-.8 0Z"};function Es({name:e,size:t=16,stroke:a=1.5,filled:n,className:r,style:o}){let s=n?a1[e]:void 0,l=`ss-icon${r?` ${r}`:""}`;if(!s&&e in Rp){let u=Rp[e];return i(u,{size:t,strokeWidth:a,absoluteStrokeWidth:!0,className:l,style:o,"aria-hidden":!0})}return i("svg",{viewBox:"0 0 16 16",width:t,height:t,className:l,style:o,"aria-hidden":!0,children:s?i("path",{d:s,fill:"currentColor",fillRule:"evenodd"}):i("path",{d:t1[e],fill:"none",stroke:"currentColor",strokeWidth:a,strokeLinecap:"round",strokeLinejoin:"round"})})}it();var Fp=document.createElement("style");Fp.textContent=`/* Check */

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
`;document.head.appendChild(Fp);function Dp({on:e,pending:t,size:a=16,className:n,...r}){return i("span",{...r,className:`ss-check${n?` ${n}`:""}`,"data-on":e||void 0,"data-pending":t&&!e||void 0,style:{width:a,height:a,...r.style},children:v("svg",{viewBox:"0 0 16 16",width:a,height:a,"aria-hidden":!0,children:[i("circle",{className:"ss-check__ring",cx:"8",cy:"8",r:"7.25"}),i("circle",{className:"ss-check__arc",cx:"8",cy:"8",r:"7.25",pathLength:1}),i("circle",{className:"ss-check__fill",cx:"8",cy:"8",r:"8"}),i("path",{className:"ss-check__tick",d:"M4.5 8.2 7 10.6l4.6-5",pathLength:1})]})})}var Bp=document.createElement("style");Bp.textContent=`/* Spinner */

@layer stageshow {
  .ss-spinner {
    flex: none;
    animation: ss-spin 0.8s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .ss-spinner { animation: none; }
  }
}
`;document.head.appendChild(Bp);function Ns({size:e=14,className:t,style:a,...n}){return v("svg",{...n,className:`ss-spinner${t?` ${t}`:""}`,viewBox:"0 0 16 16",width:e,height:e,style:a,"aria-hidden":!0,children:[i("circle",{cx:"8",cy:"8",r:"6.25",fill:"none",stroke:"currentColor",strokeOpacity:"0.18",strokeWidth:"1.5"}),i("path",{d:"M8 1.75a6.25 6.25 0 0 1 6.25 6.25",fill:"none",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round"})]})}var Ep=()=>window.matchMedia("(prefers-color-scheme: dark)");function oo(){let[e,t]=pe(()=>Ep().matches);return Ct(()=>{let a=Ep(),n=()=>t(a.matches);return a.addEventListener("change",n),()=>a.removeEventListener("change",n)},[]),e}function wt({children:e,className:t}){return i("span",{className:t,children:e.map((a,n)=>v("span",{children:[n>0&&" ",i("span",{className:"ph",children:a})]},n))})}function so({size:e=22}){return v("svg",{className:"dz-mark",viewBox:"3.5 3.5 17 17",width:e,height:e,"aria-hidden":!0,children:[i("circle",{cx:"7.4",cy:"7.4",r:"3.1"}),i("circle",{cx:"16.6",cy:"7.4",r:"1.9"}),i("circle",{cx:"7.4",cy:"16.6",r:"1.9"}),i("circle",{className:"dz-mark__dot",cx:"16.6",cy:"16.6",r:"3.1"})]})}function Os({send:e,at:t,target:a="send"}){return v("div",{className:"dz-acts-cell",children:[v("div",{className:"dz-acts","data-off":e==="done"||void 0,children:[v("span",{className:"dz-btn dz-btn--send","data-target":a,"data-cursor":"pointer",children:[i("span",{className:"dz-layer","data-on":e==="idle"||void 0,children:"보내기"}),i("span",{className:"dz-layer","data-on":e==="busy"||void 0,children:i(Ns,{size:14})})]}),i("span",{className:"dz-btn",children:"고치기"}),i("span",{className:"dz-btn dz-btn--text",children:"보내지 않기"})]}),v("div",{className:"dz-sent","data-off":e!=="done"||void 0,children:[i(Dp,{on:e==="done",size:16}),"보냈어요",i("span",{className:"dz-sent__time",children:t})]})]})}var Np=document.createElement("style");Np.textContent=`.hz-win {
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

.dz-mark { flex: none; fill: var(--ink); }
.dz-mark__dot { fill: var(--accent); }

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
.hz-caret { margin-left: -4px; color: var(--muted); }
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
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 52px;
  padding: 0 16px 0 8px;
}
.hz-back { position: absolute; left: -14px; color: var(--muted); }
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
.hz-cvh { flex: none; display: grid; gap: 2px; padding: 14px 20px 8px; }
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
.hz-ph { flex: 1; min-width: 0; }
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


.hz .ss-stage[data-layout='compact'] .hz-win {
  left: 8px;
  width: 342px;
  height: 544px;
}
.hz .ss-stage[data-layout='compact'] .hz-app { display: flex; flex-direction: column; }
.hz .ss-stage[data-layout='compact'] .hz-main { flex: 1; }
.hz .ss-stage[data-layout='compact'] .hz-bar { height: 46px; padding: 0 4px 0 36px; }
.hz .ss-stage[data-layout='compact'] .hz-back { left: 10px; }
.hz .ss-stage[data-layout='compact'] .hz-cmdk { width: 32px; padding: 0; justify-content: center; background: transparent; }
.hz .ss-stage[data-layout='compact'] .hz-cmdk span,
.hz .ss-stage[data-layout='compact'] .hz-cmdk kbd { display: none; }
.hz .ss-stage[data-layout='compact'] .hz-cv { margin: 0 8px 8px; }
.hz .ss-stage[data-layout='compact'] .hz-thread { padding: 0 16px 10px; }
.hz .ss-stage[data-layout='compact'] .hz-dock { margin: 0 8px 6px; padding: 10px 12px; }
.hz .ss-stage[data-layout='compact'] .hz-cmp { padding: 4px 8px 8px; }
.hz .ss-stage[data-layout='compact'] .hz-box { height: 42px; }
.hz .ss-stage[data-layout='compact'] .hz-text { font-size: 13.5px; }
.hz .ss-stage[data-layout='compact'] .dz-btn { padding: 0 11px; }
.hz .ss-stage[data-layout='compact'] .dz-btn--text { padding: 0 6px; }
`;document.head.appendChild(Np);var n1={mail:!1,summary:!1,draft:!1,dock:!1,send:"idle"},r1={mail:!0,summary:!0,draft:!0,dock:!1,send:"done"};async function o1(e){await e.wait(700),e.put({mail:!0}),await e.wait(1100),e.put({summary:!0}),await e.wait(1300),e.put({draft:!0,dock:!0}),await e.wait(1500),await e.click({at:"send",x:0.55,y:0.6}),e.put({send:"busy"}),await e.wait(800),e.put({send:"done"}),await e.move({wide:{x:900,y:470},compact:{x:320,y:470}}),await e.wait(900),e.put({dock:!1}),await e.wait(2000),e.put({draft:!1}),await e.wait(70),e.put({summary:!1}),await e.wait(70),e.put({mail:!1}),await e.wait(700),e.put({send:"idle"})}var lo={size:18,strokeWidth:1.75,absoluteStrokeWidth:!0,"aria-hidden":!0},s1=[{name:"홈",icon:i(zt,{...lo})},{name:"채팅",icon:i(Gr,{...lo}),on:!0},{name:"프로젝트",icon:i(Or,{...lo})},{name:"모니터링",icon:i(Pr,{...lo})},{name:"설정",icon:i(Qr,{...lo})}];function l1(){return v("div",{className:"hz-side",children:[v("div",{className:"hz-brand",children:[i(so,{size:18}),"dotz",i(Ba,{className:"hz-caret",size:14,"aria-hidden":!0})]}),i("nav",{className:"hz-nav",children:s1.map((e)=>v("span",{className:"hz-ni","data-on":e.on||void 0,children:[e.icon,e.name]},e.name))}),v("div",{className:"hz-use",children:["사용량",i("span",{className:"hz-use__bar",children:i("i",{})}),i("span",{children:"7일 18%"})]})]})}function yi(){let e=oo();return i(Bs,{className:"dz hz",width:1000,height:600,compact:{below:600,width:358,height:560},fill:!0,theme:e?"dark":"light",initial:n1,poster:r1,script:o1,play:"loop",cursor:{at:{wide:{x:900,y:470},compact:{x:320,y:470}}},children:(t,a,n)=>i(Ap,{title:"dotz",className:"hz-win",children:v("div",{className:"hz-app",children:[n==="wide"&&i(l1,{}),v("div",{className:"hz-main",children:[v("div",{className:"hz-bar",children:[i(Fr,{className:"hz-back",size:n==="wide"?15:20,"aria-hidden":!0}),i("h2",{children:n==="wide"?"채팅":"dotz"}),v("span",{className:"hz-cmdk",children:[i(Na,{size:15,"aria-hidden":!0}),i("span",{children:"명령"}),i("kbd",{children:"⌘K"})]}),v("span",{className:"hz-bell",children:[i(Da,{size:18,strokeWidth:1.75,"aria-hidden":!0}),i("span",{className:"hz-bd",children:"1"})]})]}),v("div",{className:"hz-cv",children:[n==="wide"&&v("div",{className:"hz-cvh",children:[i("b",{children:"dotz"}),i("span",{children:"대기"})]}),v("div",{className:"hz-thread",children:[v("div",{className:"hz-msg hz-me",children:[i("span",{className:"hz-bub",children:i(wt,{children:["새 메일이 오면","요약하고 답장 초안 써 줘"]})}),i("span",{className:"hz-mm",children:"오전 9:12"})]}),v("div",{className:"hz-msg",children:[v("span",{className:"hz-mm",children:[i("b",{children:"dotz"})," · 오전 9:12"]}),i(wt,{className:"hz-text",children:["알겠어요.","보내기 전에 꼭 물어볼게요."]})]}),i(Ve,{open:t.mail,reveal:"drop",from:"below",children:v("div",{className:"hz-sys",children:[i(Es,{name:"mail",size:13}),i("span",{children:"새 메일 · 한지우 · 다음 주 촬영 일정"})]})}),i(Ve,{open:t.summary,reveal:"drop",from:"below",children:v("div",{className:"hz-msg",children:[v("span",{className:"hz-mm",children:[i("b",{children:"dotz"})," · 오전 9:41"]}),i(wt,{className:"hz-text",children:["한지우 님이","다음 주 화요일 오후에","촬영이 되는지 물어봤어요."]})]})}),i(Ve,{open:t.draft,reveal:"drop",from:"below",children:v("div",{className:"hz-q",children:[v("div",{className:"hz-q__hd",children:[v("span",{className:"hz-mm",children:["답장 초안 · ",i("b",{children:"한지우"})]}),v("span",{className:"dz-swap",children:[i("span",{className:"dz-tag dz-tag--warn","data-off":t.send==="done"||void 0,children:"확인 필요"}),i("span",{className:"dz-tag dz-tag--ok","data-off":t.send!=="done"||void 0,children:"보냈어요"})]})]}),i(wt,{className:"hz-q__body",children:["화요일 오후 2시 좋아요.","성수 스튜디오에서 뵐게요."]})]})})]}),i(Ve,{open:t.dock,reveal:"drop",from:"below",children:v("div",{className:"hz-dock",children:[v("div",{className:"hz-dock__q",children:[i("span",{className:"dz-tag dz-tag--warn",children:"확인 필요"}),i(wt,{className:"hz-dock__t",children:["한지우 님께","이 답장을 보낼까요?"]})]}),i(Os,{send:t.send,at:"오전 9:42"})]})}),i("div",{className:"hz-cmp",children:v("div",{className:"hz-box",children:[i(Ea,{size:18,strokeWidth:1.75,"aria-hidden":!0}),i("span",{className:"hz-ph",children:"메시지 보내기"}),i("span",{className:"hz-send",children:i(zr,{size:16,strokeWidth:2,"aria-hidden":!0})})]})})]})]})]})})})}it();var Op=document.createElement("style");Op.textContent=`/* Phones (phone.tsx): frames, the status bar, the lock screen and
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
`;document.head.appendChild(Op);var u1={w:402,h:874,r:64},Up={a:71,n:2.31},i1={w:393,h:829,r:42},d1={w:412,h:915,r:38},f1={pro:{band:3,glass:10},photo:{band:0,glass:16},bezel:{band:0,glass:12},soft:{band:0,glass:12.5},bare:{band:0,glass:0},silver:{band:4,glass:9},clay:{band:0,glass:16},outline:{band:0,glass:8},android:{band:2,glass:9}},c1={pro:[[13,"band"],[10,"var(--ss-phone-rim)"],[9.25,"var(--ss-phone-glass)"]],silver:[[13,"band"],[9,"var(--ss-phone-glass)"]],bezel:[[12,"var(--ss-phone-glass)"]],clay:[[16,"clay"],[1,"var(--ss-phone-seam)"]]};function p1(e,t,a,n){let o=2/n,s=[];return[[e-a,a,1,-1],[e-a,t-a,1,1],[a,t-a,-1,1],[a,a,-1,-1]].forEach(([u,c,m,g],h)=>{for(let w=0;w<=32;w++){let x=w/32*(Math.PI/2),k=h%2===0?Math.sin(x):Math.cos(x),B=h%2===0?Math.cos(x):Math.sin(x);s.push(`${(u+m*a*Math.pow(k,o)).toFixed(2)} ${(c+g*a*Math.pow(B,o)).toFixed(2)}`)}}),`M${s.join("L")}Z`}function Hp({width:e,frame:t="pro",time:a="9:41",island:n,status:r,dark:o,wallpaper:s,className:l,style:u,children:c,...m}){let g=Z(null),[h,w]=pe(!0);Ct(()=>{if(t!=="photo"||!g.current)return;let Le=getComputedStyle(g.current).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/)?.[1];if(!Le)return void w(!1);let Lt=!0,Ge=new Image;return Ge.onerror=()=>Lt&&w(!1),Ge.src=Le,()=>{Lt=!1}},[t,o]);let x=t==="photo"&&!h?"pro":t,{band:k,glass:B}=f1[x],{fidelity:f}=wi(),d=x==="android"?d1:x==="soft"?i1:u1,p=k+B,L=e/(d.w+p*2),I=(Fe)=>Fe*L,T=Qs().replace(/:/g,""),y=x!=="android"&&x!=="soft"?p1(I(d.w),I(d.h),I(Up.a),Up.n):null,Q=c1[x],D=x==="pro"||x==="photo"||x==="bezel"||x==="silver"||x==="android",V=n??(D&&x!=="photo"),ot=r??D;return v("div",{...m,className:`ss-phone${l?` ${l}`:""}`,"data-frame":x,"data-dark":o||void 0,style:{width:e,height:I(d.h+p*2),padding:I(k),borderRadius:I(d.r+p),["--ps"]:`${L}px`,...u},children:[(Q||x==="outline")&&y&&v("svg",{className:"ss-phone__bands",width:"100%",height:"100%","aria-hidden":!0,children:[v("defs",{children:[i("linearGradient",{id:`${T}-band`,x1:"0.2",y1:"0",x2:"0.8",y2:"1",children:[0,0.22,0.48,0.74,1].map((Fe,Le)=>i("stop",{offset:Fe,style:{stopColor:`var(--ss-phone-band-${Le+1})`}},Fe))}),v("linearGradient",{id:`${T}-clay`,x1:"0",y1:"0",x2:"0",y2:"1",children:[i("stop",{offset:"0",style:{stopColor:"var(--ss-phone-clay-top)"}}),i("stop",{offset:"1",style:{stopColor:"var(--ss-phone-clay-bottom)"}})]}),x==="outline"&&v("mask",{id:`${T}-ring`,maskUnits:"userSpaceOnUse",x:"-50%",y:"-50%",width:"200%",height:"200%",children:[i("path",{d:y,fill:"none",stroke:"#fff",strokeWidth:I(16)}),i("path",{d:y,fill:"none",stroke:"#000",strokeWidth:I(16)-2})]})]}),i("g",{transform:`translate(${I(p)} ${I(p)})`,strokeLinejoin:"round",children:x==="outline"?v(Tt,{children:[i("rect",{x:-I(9),y:-I(9),width:I(d.w+18),height:I(d.h+18),mask:`url(#${T}-ring)`,style:{fill:"var(--ss-phone-line)"}}),i("path",{d:y,fill:"none",strokeWidth:"2",style:{stroke:"var(--ss-line, rgba(0, 0, 0, 0.06))"}})]}):Q.map(([Fe,Le])=>i("path",{d:y,fill:"none",strokeWidth:I(Fe*2),stroke:Le==="band"||Le==="clay"?`url(#${T}-${Le})`:void 0,style:Le==="band"||Le==="clay"?void 0:{stroke:Le}},Fe))})]}),i("div",{className:"ss-phone__glass",style:{padding:I(B),borderRadius:I(d.r+B)},children:i("div",{className:"ss-phone__window",style:{width:I(d.w),height:I(d.h),borderRadius:y?void 0:I(d.r),clipPath:y?`path('${y}')`:void 0},children:v("div",{className:"ss-phone__screen",style:{width:d.w,height:d.h,transform:`scale(${L})`,["--ss-screen-r"]:`${d.r}px`,...s?{background:s}:null},children:[ot&&v("div",{className:"ss-phone__status",children:[i("span",{className:"ss-phone__time",children:f==="minimal"?i("span",{className:"ss-phone__time-bar"}):a}),v("span",{className:"ss-phone__glyphs",children:[i(m1,{}),i(h1,{}),i(g1,{})]})]}),V&&i("span",{className:"ss-phone__island"}),i("div",{className:"ss-phone__content","data-status":ot||void 0,children:c}),D&&i("span",{className:"ss-phone__home"})]})})}),x==="photo"&&i("span",{ref:g,className:"ss-phone__photo",style:{left:I(-8),top:I(-7),width:I(450),height:I(920)}})]})}function m1(){return i("svg",{viewBox:"0 0 20.33 13.67",width:"20.33",height:"13.67",className:"ss-phone__glyph ss-phone__signal",children:[6.33,8.67,11,13.67].map((e,t)=>i("rect",{x:t*5.667,y:13.67-e,width:3.333,height:e,rx:1.667,fill:"currentColor"},t))})}function h1(){return i("svg",{viewBox:"0 0 19.33 14.33",width:"19.33",height:"14.33",className:"ss-phone__glyph ss-phone__wifi",children:i("path",{fillRule:"evenodd",fill:"currentColor",d:"M0.415933 5.54283C0.902185 6.04412 1.66017 5.95818 2.27513 5.41393C4.30595 3.58064 6.83731 2.63535 9.66901 2.63535C12.5007 2.63535 15.0464 3.60928 17.0629 5.41393C17.6636 5.97251 18.4215 6.0298 18.9221 5.54283C19.4226 5.02722 19.4942 4.2538 18.9793 3.70954C16.8341 1.51819 13.3302 0 9.66901 0C6.00783 0 2.48965 1.53251 0.358727 3.72387C-0.156127 4.2538 -0.0989213 5.02722 0.415933 5.55715L0.415933 5.54283ZM3.94841 9.13779C4.50617 9.68205 5.22124 9.62476 5.85051 9.10915C6.88022 8.29276 8.25316 7.73418 9.66901 7.7485C11.0706 7.7485 12.4435 8.29276 13.4875 9.12347C14.1168 9.63908 14.8605 9.66773 15.4039 9.12347C15.9331 8.57921 16.0189 7.7485 15.4611 7.23289C14.0739 5.98683 11.9859 5.11315 9.68332 5.11315C7.38077 5.11315 5.27845 5.98683 3.9055 7.23289C3.41925 7.69121 3.31914 8.47896 3.96271 9.13779L3.94841 9.13779ZM8.72511 13.8929C9.34008 14.4801 9.98365 14.4801 10.5986 13.8929L11.757 12.7757C12.372 12.1742 12.5007 11.4151 11.7999 10.8995C11.2136 10.4841 10.4699 10.212 9.66901 10.212C8.86813 10.212 8.11015 10.4841 7.53809 10.9138C6.83731 11.4151 6.98033 12.1885 7.59529 12.7757L8.73942 13.8929L8.72511 13.8929Z"})})}function g1(){return v("svg",{viewBox:"0 0 29.33 13.67",width:"29.33",height:"13.67",className:"ss-phone__glyph ss-phone__battery",children:[i("path",{fill:"currentColor",d:"M0 6.4C0 4.15979 0 3.03969 0.435974 2.18404C0.819467 1.43139 1.43139 0.819467 2.18404 0.435974C3.03969 0 4.15979 0 6.4 0L19.933 0C22.1732 0 23.2933 0 24.149 0.435974C24.9016 0.819467 25.5135 1.43139 25.897 2.18404C26.333 3.03969 26.333 4.15979 26.333 6.4L26.333 7.26666C26.333 9.50687 26.333 10.627 25.897 11.4826C25.5135 12.2353 24.9016 12.8472 24.149 13.2307C23.2933 13.6667 22.1732 13.6667 19.933 13.6667L6.4 13.6667C4.15979 13.6667 3.03969 13.6667 2.18404 13.2307C1.43139 12.8472 0.819467 12.2353 0.435974 11.4826C0 10.627 0 9.50687 0 7.26666L0 6.4Z"}),i("path",{fillRule:"evenodd",fill:"currentColor",transform:"translate(27.33 4.33)",d:"M0 0L0 5C0.601505 4.8625 2 3.75 2 2.5C2 1.25 0.601505 0.1375 0 0Z"})]})}var qp=document.createElement("style");qp.textContent=`.cz .ss-stage { overflow: hidden; }

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

/* An even inset on all four sides, so the panel sits in the frame instead of bleeding off it. */
.cz.cz--mail .ss-stage .cz-panel { top: 14px; right: 14px; bottom: 14px; left: 14px; width: auto; height: auto; gap: 8px; padding: 14px 16px; }
.cz--mail .cz-draft { max-width: none; }
`;document.head.appendChild(qp);function vi({name:e,initial:t,poster:a,script:n,bare:r,children:o}){let s=oo();return i(Bs,{className:`dz cz cz--${e}`,width:520,height:280,compact:{below:440,width:350,height:270},theme:s?"dark":"light",initial:t,poster:a,script:n,play:"loop",fill:!0,children:(l)=>i("div",{className:`cz-panel${r?" cz-panel--bare":""}`,children:o(l)})})}function Vp(){return i(vi,{name:"mail",initial:{mail:!1,summary:!1,draft:!1,wait:!1},poster:{mail:!0,summary:!0,draft:!0,wait:!0},script:async(e)=>{await e.wait(500),e.put({mail:!0}),await e.wait(900),e.put({summary:!0}),await e.wait(1000),e.put({draft:!0}),await e.wait(800),e.put({wait:!0}),await e.wait(3200),e.put({wait:!1,draft:!1}),await e.wait(70),e.put({summary:!1}),await e.wait(70),e.put({mail:!1}),await e.wait(600)},children:(e)=>v(Tt,{children:[i(Ve,{open:e.mail,reveal:"drop",from:"below",children:v("div",{className:"cz-chip",children:[i(Es,{name:"mail",size:13}),i(wt,{children:["새 메일 · 한지우","· 다음 주 촬영 일정"]})]})}),i(Ve,{open:e.summary,reveal:"drop",from:"below",children:v("div",{className:"cz-head",children:[i(so,{size:22}),i(wt,{className:"cz-text",children:["화요일 오후에","촬영이 되는지 묻는 메일이에요."]})]})}),i(Ve,{open:e.draft,reveal:"drop",from:"below",children:v("div",{className:"dz-draft cz-draft","data-wait":e.wait||void 0,children:[v("div",{className:"dz-draft__hd",children:[i("span",{className:"dz-draft__title",children:"답장 초안"}),i("span",{className:"dz-tag dz-tag--warn",children:"확인 필요"})]}),i("div",{className:"dz-draft__body",children:i(wt,{children:["화요일 오후 2시 좋아요."]})}),i(Os,{send:"idle",at:"방금"})]})})]})})}var Wp=[["10:00","팀 주간 회의"],["13:30","치과 예약"]];function Gp(){let e=oo();return i(vi,{name:"phone",bare:!0,initial:{ask:!1,busy:!1,reply:!1,rows:0},poster:{ask:!0,busy:!1,reply:!0,rows:2},script:async(t)=>{await t.wait(500),t.put({ask:!0}),await t.wait(700),t.put({busy:!0}),await t.wait(1300),t.put({busy:!1,reply:!0}),await t.wait(500);for(let a=1;a<=Wp.length;a++)t.put({rows:a}),await t.wait(260);await t.wait(3000),t.put({rows:0}),await t.wait(70),t.put({reply:!1}),await t.wait(70),t.put({ask:!1}),await t.wait(600)},children:(t)=>i(Hp,{width:304,frame:"bezel",time:"8:30",dark:e,wallpaper:"var(--surface)",className:"cz-phone",children:v("div",{className:"cz-chat",children:[v("div",{className:"cz-chat__hd",children:[i(so,{size:18}),i("b",{children:"dotz"})]}),i(Ve,{open:t.ask,reveal:"drop",from:"below",children:i("div",{className:"cz-me",children:i("span",{children:"오늘 일정 알려 줘"})})}),i(Ve,{open:t.busy,children:v("div",{className:"cz-busy",children:[i(Ns,{size:12}),"확인하는 중"]})}),i(Ve,{open:t.reply,reveal:"drop",from:"below",children:i(wt,{className:"cz-text",children:["오늘 일정은 두 개예요."]})}),i("div",{className:"cz-list",children:Wp.map(([a,n],r)=>i(Ve,{open:t.rows>r,children:v("div",{className:"cz-ev",children:[i("span",{className:"cz-ev__t",children:a}),i("span",{className:"cz-ev__title",children:n})]})},a))})]})})})}function jp(){return i(vi,{name:"watch",bare:!0,initial:{drop:!1,alert:!1},poster:{drop:!0,alert:!0},script:async(e)=>{await e.wait(1100),e.put({drop:!0}),await e.wait(1100),e.put({alert:!0}),await e.wait(3400),e.put({alert:!1}),await e.wait(200),e.put({drop:!1}),await e.wait(600)},children:(e)=>v(Tt,{children:[v("div",{className:"cz-watch",children:[v("span",{className:"cz-nt__b",children:[i("b",{children:"캠핑 의자"}),i("span",{children:"지켜보는 중"})]}),i("span",{className:"cz-amt",children:v("span",{className:"dz-swap",children:[i("span",{"data-off":e.drop||void 0,children:"89,000원"}),i("em",{"data-off":!e.drop||void 0,children:"72,000원"})]})})]}),i("div",{className:"cz-title",children:"알림"}),v("div",{className:"cz-nts",children:[i(Ve,{open:e.alert,reveal:"drop",children:v("div",{className:"cz-nt","data-unread":!0,children:[i("span",{className:"cz-nt__dot"}),v("span",{className:"cz-nt__b",children:[i("b",{children:"가격이 바뀌었어요"}),v("span",{className:"cz-price",children:["캠핑 의자 ",i("s",{children:"89,000원"})," → ",i("em",{children:"72,000원"})]})]}),i("span",{className:"cz-nt__time",children:"방금"})]})}),v("div",{className:"cz-nt",children:[i("span",{className:"cz-nt__dot"}),v("span",{className:"cz-nt__b",children:[i("b",{children:"로그인 유지"}),i("span",{children:"사이트 세 곳 · 바뀐 것 없음"})]}),i("span",{className:"cz-nt__time",children:"오전 8:00"})]})]})]})})}var x1={hero:yi,mail:Vp,phone:Gp,watch:jp},w1=(e)=>{let t=x1[e.dataset.ss??""];if(!t)return;$p.createRoot(e).render(i(t,{})),e.closest(".shot, .card")?.classList.add("ss-live")},Kp=new IntersectionObserver((e)=>{for(let t of e){if(!t.isIntersecting)continue;Kp.unobserve(t.target),w1(t.target)}},{rootMargin:"300px 0px"});for(let e of document.querySelectorAll("[data-ss]"))Kp.observe(e);
