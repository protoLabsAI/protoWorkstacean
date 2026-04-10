import{d as p,y as k}from"./hooks.module.JM0_Ku3s.js";import{u as e}from"./jsxRuntime.module.BbxW1e5M.js";function z({successRate:a,totalRuns:r,failedRuns:t}){const n=Math.round(a*100),i=n>=90?"var(--text-success)":n>=70?"var(--text-warning)":"var(--text-danger)";return e("div",{class:"ci-bar",children:[e("div",{class:"ci-bar__track",children:e("div",{class:"ci-bar__fill",style:{width:`${n}%`,background:i}})}),e("div",{class:"ci-bar__labels",children:[e("span",{class:"ci-bar__pct",style:{color:i},children:[n,"%"]}),e("span",{class:"ci-bar__detail",children:[r," runs · ",t," failed"]})]}),e("style",{children:`
        .ci-bar {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .ci-bar__track {
          height: 6px;
          background: var(--bg-subtle);
          border-radius: 3px;
          overflow: hidden;
        }
        .ci-bar__fill {
          height: 100%;
          border-radius: 3px;
          transition: width 0.3s ease;
        }
        .ci-bar__labels {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 11px;
        }
        .ci-bar__pct {
          font-weight: 600;
        }
        .ci-bar__detail {
          color: var(--text-secondary);
        }
      `})]})}function P({conflicting:a,stale:r,failing:t}){return a>0||r>0||t>0?e("span",{class:"pr-badges",children:[a>0&&e("span",{class:"badge badge-red",children:[a," conflict",a!==1?"s":""]}),r>0&&e("span",{class:"badge badge-yellow",children:[r," stale"]}),t>0&&e("span",{class:"badge badge-red",children:[t," failing"]}),e("style",{children:`
        .pr-badges {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          flex-wrap: wrap;
        }
      `})]}):e("span",{class:"badge badge-green",children:"clean"})}function C(a){return new Date(a).toLocaleDateString("en-US",{month:"short",day:"numeric"})}function j({project:a,ci:r,prs:t}){const[n,i]=p(!1),o=t.length,d=t.filter(s=>s.mergeable==="dirty").length,x=t.filter(s=>s.stale).length,h=t.filter(s=>!s.checksPass).length,u=r?.latestConclusion==="success"?"var(--text-success)":r?.latestConclusion==="failure"?"var(--text-danger)":"var(--text-secondary)";return e("div",{class:"project-card card",children:[e("div",{class:"pc-header",children:[e("div",{class:"pc-title-row",children:[e("span",{class:"pc-title",children:a.title}),e("span",{class:"badge badge-blue",children:a.status??"active"})]}),e("div",{class:"pc-meta",children:[a.github&&e("a",{href:a.repoUrl??`https://github.com/${a.github}`,target:"_blank",rel:"noopener noreferrer",class:"pc-github-link",children:a.github}),a.agents&&a.agents.length>0&&e("span",{class:"pc-agents",children:a.agents.map(s=>e("span",{class:"badge badge-blue pc-agent-badge",children:s},s))})]})]}),e("div",{class:"pc-section",children:[e("div",{class:"pc-section-label",children:"CI Health"}),r?e("div",{class:"pc-ci",children:[e(z,{successRate:r.successRate,totalRuns:r.totalRuns,failedRuns:r.failedRuns}),r.latestConclusion&&e("span",{class:"pc-conclusion",style:{color:u},children:["latest: ",r.latestConclusion]})]}):e("span",{class:"pc-no-data",children:"No CI data"})]}),e("div",{class:"pc-section",children:[e("div",{class:"pc-section-label",children:["Pull Requests",o>0&&e("span",{class:"pc-pr-count",children:[o," open"]})]}),e("div",{class:"pc-pr-row",children:[e(P,{conflicting:d,stale:x,failing:h}),o>0&&e("button",{class:"pc-expand-btn",onClick:()=>i(s=>!s),children:[n?"Hide":"Show"," PRs"]})]}),n&&o>0&&e("div",{class:"pc-pr-list",children:t.map(s=>e("div",{class:"pc-pr-item",children:[e("span",{class:"pc-pr-number",children:["#",s.number]}),e("span",{class:"pc-pr-title",children:s.title}),e("span",{class:"pc-pr-badges",children:[s.mergeable==="dirty"&&e("span",{class:"badge badge-red",children:"conflict"}),s.stale&&e("span",{class:"badge badge-yellow",children:"stale"}),!s.checksPass&&e("span",{class:"badge badge-red",children:"failing"})]}),e("span",{class:"pc-pr-date",children:C(s.updatedAt)})]},`${s.repo}/${s.number}`))})]}),e("style",{children:`
        .project-card {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .pc-header {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .pc-title-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .pc-title {
          font-size: 15px;
          font-weight: 600;
          color: var(--text-primary);
        }
        .pc-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .pc-github-link {
          font-size: 12px;
          color: var(--text-link);
        }
        .pc-agents {
          display: inline-flex;
          gap: 4px;
        }
        .pc-agent-badge {
          font-size: 10px;
          padding: 1px 6px;
        }
        .pc-section {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding-top: 12px;
          border-top: 1px solid var(--border-muted);
        }
        .pc-section-label {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .pc-pr-count {
          font-size: 11px;
          font-weight: 500;
          color: var(--text-primary);
          text-transform: none;
          letter-spacing: 0;
        }
        .pc-ci {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .pc-conclusion {
          font-size: 11px;
        }
        .pc-no-data {
          font-size: 12px;
          color: var(--text-secondary);
          font-style: italic;
        }
        .pc-pr-row {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .pc-expand-btn {
          background: none;
          border: 1px solid var(--border-default);
          color: var(--text-secondary);
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 4px;
          cursor: pointer;
          transition: color 0.1s, border-color 0.1s;
        }
        .pc-expand-btn:hover {
          color: var(--text-primary);
          border-color: var(--text-secondary);
        }
        .pc-pr-list {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-top: 4px;
        }
        .pc-pr-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 8px;
          background: var(--bg-subtle);
          border-radius: 4px;
          font-size: 12px;
        }
        .pc-pr-number {
          color: var(--text-secondary);
          flex-shrink: 0;
          font-size: 11px;
        }
        .pc-pr-title {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text-primary);
        }
        .pc-pr-badges {
          display: flex;
          gap: 4px;
          flex-shrink: 0;
        }
        .pc-pr-date {
          color: var(--text-secondary);
          font-size: 11px;
          flex-shrink: 0;
        }
      `})]})}const S=6e4;function $(){const[a,r]=p([]),[t,n]=p(null),[i,o]=p(null),[d,x]=p(null),[h,u]=p(!0),[s,y]=p(null);async function b(){try{const[l,c,v]=await Promise.all([fetch("/api/projects"),fetch("/api/ci-health"),fetch("/api/pr-pipeline")]);if(!l.ok)throw new Error(`/api/projects: ${l.status}`);if(!c.ok)throw new Error(`/api/ci-health: ${c.status}`);if(!v.ok)throw new Error(`/api/pr-pipeline: ${v.status}`);const m=await l.json(),_=await c.json(),R=await v.json();r(Array.isArray(m.data)?m.data:[]),n(_),o(R),x(null),y(new Date)}catch(l){x(l instanceof Error?l.message:String(l))}finally{u(!1)}}k(()=>{b();const l=setInterval(b,S);return()=>clearInterval(l)},[]);const w=new Map((t?.projects??[]).map(l=>[l.repo,l])),f=new Map;for(const l of i?.prs??[]){const c=f.get(l.repo)??[];c.push(l),f.set(l.repo,c)}const g=t&&t.totalRuns>0?Math.round(t.successRate*100):null;return e("div",{class:"projects-view",children:[t&&e("div",{class:"pv-summary card",children:[e("div",{class:"pv-summary-title",children:"CI Summary"}),e("div",{class:"pv-summary-stats",children:[e("div",{class:"pv-stat",children:[e("span",{class:"pv-stat-value",style:{color:g!==null&&g>=90?"var(--text-success)":g!==null&&g>=70?"var(--text-warning)":"var(--text-danger)"},children:g!==null?`${g}%`:"—"}),e("span",{class:"pv-stat-label",children:"success rate"})]}),e("div",{class:"pv-stat",children:[e("span",{class:"pv-stat-value",children:t.totalRuns}),e("span",{class:"pv-stat-label",children:"total runs"})]}),e("div",{class:"pv-stat",children:[e("span",{class:"pv-stat-value",style:{color:t.failedRuns>0?"var(--text-danger)":void 0},children:t.failedRuns}),e("span",{class:"pv-stat-label",children:"failed"})]}),i&&e("div",{class:"pv-stat",children:[e("span",{class:"pv-stat-value",children:i.totalOpen}),e("span",{class:"pv-stat-label",children:"open PRs"})]})]})]}),e("div",{class:"pv-header",children:[e("h2",{class:"pv-title",children:"Projects"}),s&&e("span",{class:"pv-updated",children:["Updated ",s.toLocaleTimeString()]})]}),h&&e("div",{class:"card",children:e("p",{class:"placeholder-content",children:"Loading projects…"})}),!h&&d&&e("div",{class:"card",style:{borderColor:"rgba(248,81,73,0.4)"},children:e("p",{style:{color:"var(--text-danger)",fontSize:"13px"},children:["Failed to load: ",d]})}),!h&&!d&&a.length===0&&e("div",{class:"card",children:e("p",{class:"placeholder-content",children:"No projects registered"})}),!h&&!d&&a.length>0&&e("div",{class:"pv-grid",children:a.map(l=>{const c=l.github??"";return e(j,{project:l,ci:w.get(c)??null,prs:f.get(c)??[]},l.slug)})}),e("style",{children:`
        .projects-view {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }
        .pv-summary {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .pv-summary-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .pv-summary-stats {
          display: flex;
          gap: 32px;
          flex-wrap: wrap;
        }
        .pv-stat {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .pv-stat-value {
          font-size: 22px;
          font-weight: 600;
          color: var(--text-primary);
          line-height: 1;
        }
        .pv-stat-label {
          font-size: 11px;
          color: var(--text-secondary);
        }
        .pv-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .pv-title {
          font-size: 16px;
          font-weight: 600;
        }
        .pv-updated {
          font-size: 12px;
          color: var(--text-secondary);
        }
        .pv-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
          gap: 16px;
        }
      `})]})}export{$ as default};
