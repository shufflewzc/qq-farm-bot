<script setup lang="ts">
import ActivityShell from '@/components/activity/ActivityShell.vue'
import YishuHuanfuActivityPanel from '@/components/activity/YishuHuanfuActivityPanel.vue'

const emit = defineEmits<{ back: [] }>()
</script>

<template>
  <ActivityShell theme="day">
    <div class="absolute inset-0 overflow-y-auto overscroll-contain p-3 sm:p-4">
      <YishuHuanfuActivityPanel @back="emit('back')" />
    </div>
  </ActivityShell>
</template>
