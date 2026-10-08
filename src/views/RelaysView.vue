<script setup lang="ts">
import PageHeader from "../components/PageHeader.vue";

// Relay management becomes a live console once xunara-server implements the
// relay platform endpoints (contract: xunara-relay/docs/relay-protocol.md).
// Until then this page states the model and the state of the implementation
// instead of showing an empty table.
const phases = [
  { title: "中继注册与身份", desc: "一次性 Enrollment Token 换取长期 Relay Identity（xunara-relay 已实现客户端）", state: "客户端就绪" },
  { title: "中继列表与状态", desc: "在线 / 降级 / 维护 / 已撤销，以及区域、线路与版本", state: "服务端进行中" },
  { title: "远程配置与灰度", desc: "带宽限速、区域改名、配置版本回滚与灰度升级", state: "规划中" },
  { title: "流量统计与计费", desc: "按方向统计（不识别内容），套餐关联与成本核算", state: "规划中" },
];
</script>

<template>
  <PageHeader title="中继管理" desc="Xunara Relay 是独立数据平面：DERP/STUN 中继、限速与健康状态。" />

  <div class="card">
    <div class="card-head"><h2>中继平台路线</h2><span class="hint">契约见 xunara-relay/docs/relay-protocol.md</span></div>
    <div class="card-body">
      <div v-for="phase in phases" :key="phase.title" style="display: flex; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--border)">
        <div>
          <div style="font-weight: 600">{{ phase.title }}</div>
          <div style="color: var(--text-muted); font-size: 12.5px; margin-top: 4px">{{ phase.desc }}</div>
        </div>
        <span class="badge" :class="phase.state === '客户端就绪' ? 'success' : phase.state === '服务端进行中' ? 'warning' : ''">{{ phase.state }}</span>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>部署一台托管中继</h2></div>
    <div class="card-body">
      <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 10px">
        在目标服务器上安装 xunara-relay，用平台签发的注册令牌启动：
      </p>
      <pre class="mono" style="background: var(--surface-2); padding: 14px; border-radius: 8px; overflow-x: auto; margin: 0">export XUNARA_RELAY_TOKEN='enroll-...'
xunara-relay -listen :443 -hostname hk1.example.com \
  -control-url https://control.example.com \
  -enroll-token-env XUNARA_RELAY_TOKEN \
  -cert-mode letsencrypt -cert-dir /var/lib/xunara-relay</pre>
    </div>
  </div>
</template>
