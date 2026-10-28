<script lang="ts">
import { defineComponent, PropType } from 'vue';
import type { Check, CheckState } from '../services/setup/preflight';

const ICONS: Record<CheckState, string> = {
  ok:      'icon-checkmark text-success',
  warning: 'icon-warning text-warning',
  error:   'icon-error text-error',
};

/** F6's preflight: each check with its result, and for a problem what to do about it */
export default defineComponent({
  name: 'SetupChecks',

  props: {
    checks: {
      type:     Array as PropType<Check[]>,
      required: true,
    },
  },

  methods: {
    icon(check: Check): string {
      return ICONS[check.state];
    },
  },
});
</script>

<template>
  <ul
    class="setup-checks"
    data-testid="libredb-setup-checks"
  >
    <li
      v-for="check in checks"
      :key="check.id"
      :class="`check-${ check.state }`"
      :data-testid="`libredb-check-${ check.id }`"
    >
      <i :class="['icon', icon(check)]" />
      <span>{{ t(`libredbStudio.setup.checks.${ check.id }.${ check.reason }`, check.args) }}</span>
    </li>
  </ul>
</template>

<style lang="scss" scoped>
.setup-checks {
  list-style: none;
  padding: 0;

  li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    margin-bottom: 6px;
  }
}
</style>
