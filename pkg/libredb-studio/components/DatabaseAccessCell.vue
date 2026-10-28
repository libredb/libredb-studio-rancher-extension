<script lang="ts">
import { defineComponent, PropType } from 'vue';
import { CNPG_CLUSTER_KIND, ContractResource } from '../contract/kinds';
import { connectionId, studioLink } from '../contract/connection-id';
import { ensureReview, reviewNow, reviewState } from '../services/access';
import type { StudioLink } from '../services/navlink';
import type { StoreLike } from '../services/types';

/**
 * The Databases page's Studio column: whether the signed-in user can open this database in Studio,
 * and why not. Opening needs a usable NavLink and the right to get the credential Secret, which a
 * SelfSubjectAccessReview answers; the Secret itself is never read.
 */
export default defineComponent({
  name: 'DatabaseAccessCell',

  props: {
    row: {
      type:     Object as PropType<ContractResource>,
      required: true,
    },
    cluster: {
      type:     String,
      required: true,
    },
    link: {
      type:    Object as PropType<StudioLink>,
      default: undefined,
    },
  },

  data() {
    return { opening: false };
  },

  computed: {
    namespace(): string {
      return this.row.metadata.namespace;
    },

    secret(): string {
      return CNPG_CLUSTER_KIND.credentialSecretName(this.row);
    },

    // Not `state`: the dashboard's global fetch mixin owns that name as data, which wins.
    access(): string {
      if (!this.link) {
        return 'not-set-up';
      }

      return reviewState(this.cluster, this.namespace, this.secret) || 'pending';
    },

    reviewKey(): string {
      return `${ this.namespace }/${ this.secret }/${ !!this.link }`;
    },
  },

  watch: {
    reviewKey: {
      immediate: true,
      handler() {
        if (this.link) {
          ensureReview(this.$store as StoreLike, this.cluster, this.namespace, this.secret);
        }
      },
    },
  },

  methods: {
    // No async/await in a .vue file: vue-jest compiles it to ES5 helpers that coverage counts as lines.
    open(): Promise<void> {
      const link = this.link as StudioLink;

      this.opening = true;

      return reviewNow(this.$store as StoreLike, this.cluster, this.namespace, this.secret).then((allowed) => {
        this.opening = false;

        if (allowed) {
          const id = connectionId(CNPG_CLUSTER_KIND.slug, this.namespace, this.row.metadata.name);

          window.open(studioLink(link.toURL, id), '_blank', 'noopener,noreferrer');
        }
      });
    },
  },
});
</script>

<template>
  <span
    class="database-access"
    :data-testid="`libredb-access-${ access }`"
  >
    <button
      v-if="access === 'allowed'"
      type="button"
      class="btn btn-sm role-primary"
      :disabled="opening"
      data-testid="libredb-open"
      @click="open"
    >{{ t('libredbStudio.databases.open') }}</button>
    <span
      v-else
      class="text-muted"
    >{{ t(`libredbStudio.databases.reason.${ access }`, { secret, namespace }) }}</span>
  </span>
</template>
