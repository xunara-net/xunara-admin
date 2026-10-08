<script setup lang="ts">
import { onMounted, ref } from "vue";
import * as ep from "../api/endpoints";
import { errorMessage } from "../api/client";
import PageHeader from "../components/PageHeader.vue";

const info = ref<{ organizations: number; users: number; plans: number; defaultPlan: string } | null>(null);
const error = ref("");

onMounted(async () => {
  try {
    const [orgs, plans, users] = await Promise.all([ep.listOrganizations(), ep.listPlans(), ep.listUsers()]);
    info.value = {
      organizations: orgs.length,
      users: users.length,
      plans: plans.plans?.length ?? 0,
      defaultPlan: plans.default,
    };
  } catch (err) {
    error.value = errorMessage(err);
  }
});
</script>

<template>
  <PageHeader title="系统信息" desc="平台部署的只读概览。" />

  <div v-if="error" class="alert error" style="margin-bottom: 16px">{{ error }}</div>

  <div class="grid cols-2">
    <div class="card">
      <div class="card-head"><h2>平台</h2></div>
      <div class="card-body">
        <div class="kv">
          <div class="k">租户数</div><div class="v">{{ info?.organizations ?? "—" }}</div>
          <div class="k">用户数</div><div class="v">{{ info?.users ?? "—" }}</div>
          <div class="k">套餐数</div><div class="v">{{ info?.plans ?? "—" }}</div>
          <div class="k">默认套餐</div><div class="v mono">{{ info?.defaultPlan || "—" }}</div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>安全说明</h2></div>
      <div class="card-body" style="color: var(--text-muted); font-size: 13px; line-height: 1.9">
        <p>· 平台令牌只保存在浏览器会话内存中，不写入 Cookie，不经过 URL。</p>
        <p>· 关闭标签页即结束会话；令牌泄露时轮换服务端环境变量即可全局失效。</p>
        <p>· 后端与租户控制台完全隔离：租户 Cookie 在平台面无效，反之亦然。</p>
      </div>
    </div>
  </div>
</template>
