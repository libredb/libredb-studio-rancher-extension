<script lang="ts">
import { defineComponent } from 'vue';
import { Banner } from '@components/Banner';
import Loading from '@shell/components/Loading.vue';
import PaginatedResourceTable from '@shell/components/PaginatedResourceTable.vue';
import { STATE, NAME, NAMESPACE, AGE } from '@shell/config/table-headers';
import { STEVE_STATE_COL, STEVE_NAME_COL, STEVE_NAMESPACE_COL, STEVE_AGE_COL } from '@shell/config/pagination-table-headers';
import StudioStatus from '../components/StudioStatus.vue';
import DatabaseAccessCell from '../components/DatabaseAccessCell.vue';
import { loadDatabasesPage, DatabasesPageState } from '../services/databases-page';
import type { StoreLike } from '../services/types';

const STUDIO_COL = {
  name:     'studio',
  labelKey: 'libredbStudio.databases.studioColumn',
  value:    'id',
  sort:     false,
  search:   false,
};

/**
 * The supported databases of this cluster that the signed-in user can list, read through the
 * cluster store with the user's own permissions, each with whether Studio can open it and why not.
 */
export default defineComponent({
  name: 'LibreDBDatabases',

  components: {
    Banner, Loading, PaginatedResourceTable, StudioStatus, DatabaseAccessCell
  },

  data() {
    return {
      page:              undefined as DatabasesPageState | undefined,
      headers:           [STATE, NAME, NAMESPACE, STUDIO_COL, AGE],
      paginationHeaders: [STEVE_STATE_COL, STEVE_NAME_COL, STEVE_NAMESPACE_COL, STUDIO_COL, STEVE_AGE_COL],
    };
  },

  computed: {
    cluster(): string {
      return this.$route.params.cluster as string;
    },
  },

  // No async/await in a .vue file: vue-jest compiles it to ES5 helpers that coverage counts as lines.
  created() {
    return loadDatabasesPage(this.$store as StoreLike, this.cluster).then((page) => {
      this.page = page;
    });
  },
});
</script>

<template>
  <div class="libredb-databases">
    <header>
      <div class="title">
        <h1>{{ t('libredbStudio.databases.label') }}</h1>
      </div>
    </header>
    <Loading v-if="!page" />
    <template v-else>
      <StudioStatus
        :status="page.status"
        :link="page.link"
        :found="page.found"
      />
      <Banner
        v-if="!page.schema"
        color="warning"
        data-testid="libredb-no-schema"
        :label="t('libredbStudio.databases.noSchema')"
      />
      <Banner
        v-else-if="!page.canList"
        color="warning"
        data-testid="libredb-cannot-list"
        :label="t('libredbStudio.databases.cannotList')"
      />
      <PaginatedResourceTable
        v-else
        :schema="page.schema"
        :headers="headers"
        :pagination-headers="paginationHeaders"
        :table-actions="false"
        data-testid="libredb-databases-table"
      >
        <template #cell:studio="{ row }">
          <DatabaseAccessCell
            :row="row"
            :cluster="cluster"
            :link="page.link"
          />
        </template>
      </PaginatedResourceTable>
    </template>
  </div>
</template>
