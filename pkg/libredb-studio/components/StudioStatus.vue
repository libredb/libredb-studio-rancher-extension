<script lang="ts">
import { defineComponent, PropType } from 'vue';
import { Banner } from '@components/Banner';
import type { StudioLink } from '../services/navlink';
import type { StudioStatus } from '../services/studio-status';

const COLORS: Record<StudioStatus, string> = {
  'not-set-up': 'warning',
  ready:        'success',
  'not-ready':  'warning',
  unknown:      'info',
  failed:       'warning',
};

/** The Databases page's header: is Studio set up in this cluster, is it running, where is it */
export default defineComponent({
  name: 'StudioStatus',

  components: { Banner },

  props: {
    status: {
      type:     String as PropType<StudioStatus>,
      required: true,
    },
    link: {
      type:    Object as PropType<StudioLink>,
      default: undefined,
    },
    found: {
      type:    Number,
      default: 0,
    },
  },

  computed: {
    color(): string {
      return COLORS[this.status];
    },
  },
});
</script>

<template>
  <div class="studio-status">
    <Banner
      :color="color"
      data-testid="libredb-studio-status"
    >
      <span>{{ t(`libredbStudio.status.${ status }`, { namespace: link?.namespace }) }}</span>
      <a
        v-if="link"
        :href="link.toURL"
        target="_blank"
        rel="noopener noreferrer nofollow"
        class="ml-10"
        data-testid="libredb-studio-link"
      >{{ t('libredbStudio.status.open') }}</a>
    </Banner>
    <Banner
      v-if="found > 1"
      color="info"
      data-testid="libredb-studio-several-links"
      :label="t('libredbStudio.status.severalLinks', { count: found, name: link?.name })"
    />
  </div>
</template>
