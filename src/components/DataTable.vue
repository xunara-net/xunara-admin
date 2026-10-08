<script setup lang="ts">
// DataTable renders the console's tables: a column list, rows, and named
// slots (`cell-<key>`) for cells that need formatting. Loading and empty
// states are part of the component so every page behaves the same.

export interface Column {
  key: string;
  title: string;
  align?: "left" | "right";
  width?: string;
}

const props = defineProps<{
  columns: Column[];
  rows: any[];
  loading?: boolean;
  emptyTitle?: string;
  emptyDesc?: string;
  /** rowKey is a field name or a function used as the v-for key. */
  rowKey?: string | ((row: any, index: number) => string | number);
}>();

function keyOf(row: any, index: number): string | number {
  if (typeof props.rowKey === "function") return props.rowKey(row, index);
  if (typeof props.rowKey === "string") return row[props.rowKey] ?? index;
  return row.id ?? index;
}
</script>

<template>
  <div v-if="loading" class="page-loading"><div class="spinner" /></div>
  <div v-else-if="rows.length === 0" class="empty">
    <div class="icon">📭</div>
    <div class="title">{{ emptyTitle || "暂无数据" }}</div>
    <div v-if="emptyDesc" class="desc">{{ emptyDesc }}</div>
  </div>
  <div v-else style="overflow-x: auto">
    <table class="table">
      <thead>
        <tr>
          <th v-for="col in columns" :key="col.key" :class="{ right: col.align === 'right' }" :style="col.width ? `width:${col.width}` : ''">
            {{ col.title }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in rows" :key="keyOf(row, index)">
          <td v-for="col in columns" :key="col.key" :class="{ right: col.align === 'right' }">
            <slot :name="`cell-${col.key}`" :row="row" :value="row[col.key]">
              {{ row[col.key] ?? "—" }}
            </slot>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
