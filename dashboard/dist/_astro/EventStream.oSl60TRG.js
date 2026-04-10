import{d as c,A as w,y as k}from"./hooks.module.JM0_Ku3s.js";import{u as o}from"./jsxRuntime.module.BbxW1e5M.js";import{S}from"./preact.module.DaYdYXBZ.js";const W=10,H=1e3,T=15e3;class j{ws=null;retryCount=0;retryDelay=H;destroyed=!1;messageHandlers=new Set;statusHandlers=new Set;url;constructor(n){const s=typeof location<"u"&&location.protocol==="https:"?"wss:":"ws:",r=typeof location<"u"?location.host:"localhost";this.url=`${s}//${r}${n}`}connect(){if(!this.destroyed){this.emit("connecting");try{this.ws=new WebSocket(this.url)}catch{this.scheduleReconnect();return}this.ws.onopen=()=>{this.retryCount=0,this.retryDelay=H,this.emit("connected")},this.ws.onmessage=n=>{try{const s=JSON.parse(n.data);for(const r of this.messageHandlers)r(s)}catch{}},this.ws.onclose=()=>{this.destroyed||(this.emit("disconnected"),this.scheduleReconnect())},this.ws.onerror=()=>{this.ws?.close()}}}scheduleReconnect(){if(this.destroyed||this.retryCount>=W)return;const n=Math.random()*500,s=Math.min(this.retryDelay+n,T);this.retryCount++,this.retryDelay=Math.min(this.retryDelay*2,T),setTimeout(()=>this.reconnect(),s)}reconnect(){this.destroyed||(this.ws=null,this.connect())}emit(n){for(const s of this.statusHandlers)s(n)}onMessage(n){return this.messageHandlers.add(n),()=>this.messageHandlers.delete(n)}onStatus(n){return this.statusHandlers.add(n),()=>this.statusHandlers.delete(n)}destroy(){this.destroyed=!0,this.ws?.close(),this.ws=null,this.messageHandlers.clear(),this.statusHandlers.clear()}}function J(t){return t?t.split(".")[0].toLowerCase():"default"}function O(t){return t?t.split(".").map(n=>n[0]).join("."):""}function _(t){return new Date(t).toLocaleTimeString("en-US",{hour12:!1})}function U(t){if(typeof t.payload=="string")return t.payload;const n=t.payload;return n&&typeof n.content=="string"?n.content:JSON.stringify(t.payload)}function X({msg:t,isExpanded:n,onClick:s}){const r=J(t.topic);return o(S,{children:[o("div",{class:"event-row",onClick:s,children:[o("span",{class:"event-time",children:_(t.timestamp)}),o("span",{class:`event-topic source-${r}`,title:t.topic,children:O(t.topic)}),o("span",{class:"event-preview",children:U(t)})]}),n&&o("div",{class:"event-detail open",children:o("pre",{children:JSON.stringify(t,null,2)})})]})}function Y(t){return new Date(t).toLocaleTimeString("en-US",{hour12:!1})}function B({msg:t,isExpanded:n,onClick:s}){const r=t.payload,i=(typeof r?.level=="string"?r.level:"log").toLowerCase(),f=typeof r?.message=="string"?r.message:"";return o(S,{children:[o("div",{class:"log-row",onClick:s,children:[o("span",{class:"event-time",children:Y(t.timestamp)}),o("span",{class:`log-level ${i}`,children:i}),o("span",{class:"log-message",children:f})]}),n&&o("div",{class:"log-detail open",children:o("pre",{children:JSON.stringify(r,null,2)})})]})}function q(t,n){if(!n)return!0;const s=n.split("."),r=(t||"").split(".");for(let i=0;i<s.length;i++){if(s[i]==="#")return!0;if(s[i]!=="*"&&s[i]!==r[i])return!1}return s.length===r.length}function A(t){return typeof t.topic=="string"&&t.topic.startsWith("debug.")}function V(){const[t,n]=c([]),[s,r]=c([]),[i,f]=c("events"),[v,L]=c(""),[g,D]=c(!1),[p,C]=c(!0),[b,R]=c("connecting"),[F,h]=c(null),u=w(null),M=w(g);M.current=g;const z=w(p);z.current=p,k(()=>{fetch("/api/events?limit=500").then(e=>e.json()).then(e=>{const a=Array.isArray(e)?e:[],x=[],l=[];a.reverse().forEach(d=>{A(d)?l.push(d):x.push(d)}),n(x),r(l)}).catch(()=>{})},[]),k(()=>{const e=new j("/ws"),a=e.onStatus(l=>R(l)),x=e.onMessage(l=>{M.current||(A(l)?r(d=>[...d,l]):n(d=>[...d,l]))});return e.connect(),()=>{a(),x(),e.destroy()}},[]),k(()=>{p&&u.current&&(u.current.scrollTop=u.current.scrollHeight)},[t,s,p]);function $(){const e=u.current;if(!e)return;const a=e.scrollHeight-e.scrollTop-e.clientHeight<50;a!==z.current&&C(a)}function I(){i==="events"?n([]):r([]),h(null)}function E(e){h(a=>a===e?null:e)}const m=i==="events"?t:s,y=v?m.filter(e=>q(e.topic,v)):m,N=b==="connected"?"status-dot connected":b==="connecting"?"status-dot connecting":"status-dot",P=b==="connected"?"Connected":b==="connecting"?"Connecting…":"Disconnected";return o(S,{children:[o("style",{children:`
        .es-header {
          display: flex;
          align-items: center;
          gap: 12px;
          background: #161b22;
          border-bottom: 1px solid #30363d;
          padding: 10px 16px;
          flex-shrink: 0;
          flex-wrap: wrap;
        }
        .es-tabs {
          display: flex;
          gap: 2px;
          background: #0d1117;
          border-radius: 6px;
          padding: 2px;
        }
        .es-tab {
          padding: 4px 14px;
          font-size: 12px;
          border-radius: 4px;
          cursor: pointer;
          color: #8b949e;
          border: none;
          background: transparent;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
          transition: all 0.15s;
        }
        .es-tab:hover { color: #c9d1d9; }
        .es-tab.active { background: #21262d; color: #c9d1d9; }

        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #f85149;
          transition: background 0.2s;
          flex-shrink: 0;
        }
        .status-dot.connected { background: #3fb950; }
        .status-dot.connecting { background: #d29922; animation: es-pulse 1s infinite; }
        @keyframes es-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

        .es-status {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          padding: 4px 10px;
          border-radius: 12px;
          background: #21262d;
          color: #c9d1d9;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
        }
        .es-badge {
          font-size: 11px;
          background: #30363d;
          padding: 2px 8px;
          border-radius: 10px;
          color: #8b949e;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
        }
        .es-toolbar {
          background: #161b22;
          border-bottom: 1px solid #30363d;
          padding: 8px 16px;
          display: flex;
          gap: 8px;
          align-items: center;
          flex-shrink: 0;
          flex-wrap: wrap;
        }
        .es-filter {
          background: #0d1117;
          border: 1px solid #30363d;
          color: #c9d1d9;
          padding: 6px 10px;
          border-radius: 6px;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
          font-size: 13px;
          width: 260px;
          outline: none;
        }
        .es-filter:focus { border-color: #58a6ff; }
        .es-filter::placeholder { color: #484f58; }
        .es-btn {
          background: #21262d;
          border: 1px solid #30363d;
          color: #c9d1d9;
          padding: 6px 12px;
          border-radius: 6px;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
          font-size: 12px;
          cursor: pointer;
          transition: background 0.15s;
        }
        .es-btn:hover { background: #30363d; }
        .es-btn.active { background: #1f6feb; border-color: #1f6feb; }
        .es-btn.paused { background: #da3633; border-color: #da3633; }

        .es-list {
          flex: 1;
          overflow: auto;
          padding: 4px 0;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
        }
        .es-list::-webkit-scrollbar { width: 8px; }
        .es-list::-webkit-scrollbar-track { background: #0d1117; }
        .es-list::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }

        .es-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 200px;
          color: #484f58;
          gap: 8px;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
          font-size: 14px;
        }

        /* Event rows */
        .event-row {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 8px 16px;
          border-bottom: 1px solid #21262d;
          cursor: pointer;
          transition: background 0.1s;
          overflow-x: auto;
        }
        .event-row:hover { background: #161b22; }
        .event-time {
          font-size: 11px;
          color: #484f58;
          white-space: nowrap;
          min-width: 70px;
          padding-top: 2px;
        }
        .event-topic {
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 4px;
          white-space: nowrap;
          font-weight: 500;
          letter-spacing: 0.5px;
        }
        .event-topic.source-agent { background: #1a1932; color: #bc8cff; }
        .event-topic.source-cli { background: #122d20; color: #3fb950; }
        .event-topic.source-signal { background: #2d1f12; color: #d29922; }
        .event-topic.source-echo { background: #1f2330; color: #79c0ff; }
        .event-topic.source-scheduler { background: #2d1229; color: #f778ba; }
        .event-topic.source-logger { background: #1a2332; color: #58a6ff; }
        .event-topic.source-event-viewer { background: #2d2a12; color: #e3b341; }
        .event-topic.source-default { background: #21262d; color: #8b949e; }
        .event-preview {
          font-size: 12px;
          color: #8b949e;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
        }
        .event-detail {
          display: none;
          padding: 0 16px 12px 98px;
          background: #0d1117;
          border-bottom: 1px solid #21262d;
        }
        .event-detail.open { display: block; }
        .event-detail pre {
          background: #161b22;
          border: 1px solid #30363d;
          border-radius: 6px;
          padding: 12px;
          font-size: 12px;
          overflow: auto;
          max-height: 400px;
          color: #c9d1d9;
          line-height: 1.5;
        }
        .event-detail-toolbar {
          display: flex;
          gap: 6px;
          margin-bottom: 6px;
        }
        .detail-btn {
          background: #21262d;
          border: 1px solid #30363d;
          color: #8b949e;
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 11px;
          cursor: pointer;
          font-family: inherit;
        }
        .detail-btn:hover { background: #30363d; color: #c9d1d9; }

        /* Log rows */
        .log-row {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 4px 16px;
          border-bottom: 1px solid #161b22;
          cursor: pointer;
          transition: background 0.1s;
        }
        .log-row:hover { background: #161b22; }
        .log-level {
          font-size: 10px;
          padding: 1px 6px;
          border-radius: 3px;
          white-space: nowrap;
          font-weight: 600;
          text-transform: uppercase;
          min-width: 44px;
          text-align: center;
        }
        .log-level.log { background: #21262d; color: #8b949e; }
        .log-level.debug { background: #1a2332; color: #58a6ff; }
        .log-level.info { background: #122d20; color: #3fb950; }
        .log-level.warn { background: #2d1f12; color: #d29922; }
        .log-level.error { background: #2d1215; color: #f85149; }
        .log-message {
          font-size: 12px;
          color: #6e7681;
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .log-detail {
          display: none;
          padding: 0 16px 12px 98px;
          background: #0d1117;
          border-bottom: 1px solid #161b22;
        }
        .log-detail.open { display: block; }
        .log-detail pre {
          background: #161b22;
          border: 1px solid #30363d;
          border-radius: 6px;
          padding: 12px;
          font-size: 12px;
          overflow: auto;
          max-height: 400px;
          color: #c9d1d9;
          line-height: 1.5;
        }
      `}),o("div",{class:"es-header",children:[o("div",{class:"es-tabs",children:[o("button",{class:`es-tab${i==="events"?" active":""}`,onClick:()=>{f("events"),h(null)},children:"Events"}),o("button",{class:`es-tab${i==="logs"?" active":""}`,onClick:()=>{f("logs"),h(null)},children:"Logs"})]}),o("div",{class:"es-status",children:[o("span",{class:N}),P]}),o("div",{class:"es-badge",children:[y.length," ",i==="events"?"events":"logs"]})]}),o("div",{class:"es-toolbar",children:[o("input",{class:"es-filter",type:"text",placeholder:i==="events"?"Filter by topic (e.g. agent.*)":"Filter by topic (e.g. debug.*)",value:v,onInput:e=>L(e.target.value)}),o("button",{class:"es-btn",onClick:I,children:"Clear"}),o("button",{class:`es-btn${g?" paused":""}`,onClick:()=>D(e=>!e),children:g?"Resume":"Pause"}),o("button",{class:`es-btn${p?" active":""}`,onClick:()=>C(e=>!e),title:"Toggle auto-scroll",children:"Auto-scroll"})]}),o("div",{class:"es-list",ref:u,onScroll:$,children:y.length===0?o("div",{class:"es-empty",children:o("p",{children:m.length===0?"Waiting for events…":"No matches for current filter"})}):y.map(e=>i==="events"?o(X,{msg:e,isExpanded:F===(e.id??e.timestamp),onClick:()=>E(e.id??e.timestamp)},e.id??e.timestamp):o(B,{msg:e,isExpanded:F===(e.id??e.timestamp),onClick:()=>E(e.id??e.timestamp)},e.id??e.timestamp))})]})}export{V as default};
