<script lang="ts">
import { defineComponent, PropType } from 'vue';
import type { UndoEvent } from '../services/setup/cleanup';
import type { StepView } from '../services/setup/install';
import { STUDIO_NAMESPACE } from '../services/setup/names';

const ICONS: Record<StepView['state'], string> = {
  pending: 'icon-dot-open text-muted',
  running: 'icon-spinner icon-spin',
  done:    'icon-checkmark text-success',
  skipped: 'icon-minus text-muted',
  failed:  'icon-error text-error',
};

/**
 * The steps of a setup, an upgrade or an uninstall as they run, and after a failure what became of
 * each thing the run had created.
 */
export default defineComponent({
  name: 'StepList',

  props: {
    steps: {
      type:     Array as PropType<StepView[]>,
      required: true,
    },
    undone: {
      type:    Array as PropType<UndoEvent[]>,
      default: () => [],
    },
    /** The heading over what became of each part: removed again after a failure, or uninstalled */
    undoneTitleKey: {
      type:    String,
      default: 'libredbStudio.setup.undoneTitle',
    },
  },

  data() {
    return { names: { namespace: STUDIO_NAMESPACE } };
  },

  methods: {
    icon(item: StepView): string {
      return ICONS[item.state];
    },
  },
});
</script>

<template>
  <div class="step-list">
    <ol data-testid="libredb-steps">
      <li
        v-for="item in steps"
        :key="item.step"
        :class="`step-${ item.state }`"
        :data-testid="`libredb-step-${ item.step }`"
      >
        <i :class="['icon', icon(item)]" />
        <span>{{ t(`libredbStudio.setup.steps.${ item.step }`, names, true) }}</span>
        <span class="text-muted">{{ t(`libredbStudio.setup.state.${ item.state }`, {}, true) }}</span>
        <span
          v-if="item.failure"
          class="text-error"
          :data-testid="`libredb-step-${ item.step }-failure`"
        >{{ t(`libredbStudio.setup.failure.${ item.failure.reason }`, item.failure.args, true) }}</span>
      </li>
    </ol>
    <template v-if="undone.length">
      <h4>{{ t(undoneTitleKey, {}, true) }}</h4>
      <ul data-testid="libredb-undone">
        <li
          v-for="item in undone"
          :key="item.undo"
          :data-testid="`libredb-undo-${ item.undo }`"
        >
          <span>{{ t(`libredbStudio.setup.undo.${ item.undo }`, names, true) }}</span>
          <span :class="item.outcome === 'failed' ? 'text-error' : 'text-muted'">{{ t(`libredbStudio.setup.outcome.${ item.outcome }`, {}, true) }}</span>
          <span v-if="item.failure">{{ t(`libredbStudio.setup.failure.${ item.failure.reason }`, item.failure.args, true) }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.step-list {
  ol, ul {
    list-style: none;
    padding: 0;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;
    margin-bottom: 6px;
  }
}
</style>
