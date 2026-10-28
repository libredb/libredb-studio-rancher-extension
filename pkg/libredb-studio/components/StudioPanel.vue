<script lang="ts">
import { defineComponent, PropType } from 'vue';
import type { ConnectionSummary } from '../contract/kinds';
import {
  openAccess, openDatabase, targetOf, OpenAccess, OpenTarget, ShellResource
} from '../services/open';

/**
 * F4, LibreDB Studio in a supported database's title bar: where the database is and who connects,
 * read from the resource alone and never a password, with Open when the user may open it in Studio
 * and the reason when not. It renders nothing where Studio is not set up in the cluster.
 */
export default defineComponent({
  name: 'StudioPanel',

  props: {
    resource: {
      type:     Object as PropType<ShellResource>,
      required: true,
    },
  },

  data() {
    return { opening: false, openFailed: false };
  },

  computed: {
    target(): OpenTarget | undefined {
      return targetOf(this.resource);
    },

    // Not `state`: the dashboard's global fetch mixin owns that name as data, which wins.
    access(): OpenAccess {
      return this.target ? openAccess(this.target) : 'not-set-up';
    },

    summary(): ConnectionSummary | undefined {
      return this.target?.kind.connectionSummary(this.resource);
    },

    reasonArgs(): Record<string, string> | undefined {
      return this.target && { secret: this.target.kind.credentialSecretName(this.resource), namespace: this.resource.metadata.namespace };
    },
  },

  methods: {
    // No async/await in a .vue file: vue-jest compiles it to ES5 helpers that coverage counts as lines.
    open(): Promise<void> {
      this.opening = true;
      this.openFailed = false;

      // A rejection, such as the link chunk failing to load after an upgrade, is shown as a failed open
      return openDatabase(this.target as OpenTarget).then(() => {
        this.opening = false;
      }, () => {
        this.opening = false;
        this.openFailed = true;
      });
    },
  },
});
</script>

<template>
  <div
    v-if="summary && access !== 'not-set-up'"
    class="libredb-studio-panel"
    data-testid="libredb-panel"
  >
    <span class="panel-title">{{ t('libredbStudio.panel.title', {}, true) }}</span>
    <span
      class="detail"
      data-testid="libredb-panel-host"
    ><span class="text-label">{{ t('libredbStudio.panel.host', {}, true) }}</span> {{ summary.host }}:{{ summary.port }}</span>
    <span
      class="detail"
      data-testid="libredb-panel-database"
    ><span class="text-label">{{ t('libredbStudio.panel.database', {}, true) }}</span> {{ summary.database }}</span>
    <span
      class="detail"
      data-testid="libredb-panel-user"
    ><span class="text-label">{{ t('libredbStudio.panel.user', {}, true) }}</span> {{ summary.user }}</span>
    <button
      v-if="access === 'allowed'"
      type="button"
      class="btn btn-sm role-primary"
      :disabled="opening"
      data-testid="libredb-panel-open"
      @click="open"
    >
      <i class="icon icon-external-link mr-5" />{{ t('libredbStudio.databases.open', {}, true) }}
    </button>
    <span
      v-if="access === 'allowed' && openFailed"
      class="text-error"
      data-testid="libredb-panel-open-failed"
    >{{ t('libredbStudio.databases.reason.failed', reasonArgs, true) }}</span>
    <span
      v-else-if="access !== 'allowed'"
      class="text-muted"
      :data-testid="`libredb-panel-${ access }`"
    >{{ t(`libredbStudio.databases.reason.${ access }`, reasonArgs, true) }}</span>
  </div>
</template>

<style lang="scss" scoped>
.libredb-studio-panel {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 20px;
  margin-top: 10px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--border-radius);

  .panel-title {
    font-weight: bold;
  }

  .text-label {
    color: var(--input-label);
    margin-right: 4px;
  }
}
</style>
