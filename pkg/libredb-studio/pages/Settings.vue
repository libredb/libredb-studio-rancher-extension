<script lang="ts">
import { defineComponent } from 'vue';
import { Banner } from '@components/Banner';
import { Checkbox } from '@components/Form/Checkbox';
import { LabeledInput } from '@components/Form/LabeledInput';
import LabeledSelect from '@shell/components/form/LabeledSelect.vue';
import Loading from '@shell/components/Loading.vue';
import SetupChecks from '../components/SetupChecks.vue';
import StepList from '../components/StepList.vue';
import StudioStatus from '../components/StudioStatus.vue';
import { PRODUCT_NAME, SETUP_ROUTE } from '../config';
import { failureOf } from '../services/setup/failure';
import { namespacesError } from '../services/setup/form';
import { RECORD_CONFIGMAP, STUDIO_NAMESPACE } from '../services/setup/names';
import {
  disableSso, enableSso, loadSettings, rotateClientSecret, saveNamespaces, uninstallStudio
} from '../services/setup/settings';
import type { UndoEvent } from '../services/setup/cleanup';
import type { StepView } from '../services/setup/install';
import type {
  AppInfo, ChangeOptions, ChangeResult, ChangeStepId, StudioSettings
} from '../services/setup/settings';
import type { SetupRecord } from '../services/setup/values';
import type { StoreLike } from '../services/types';

type ChangeKind = 'namespaces' | 'sso' | 'rotate' | 'ssoOff' | 'uninstall';

/**
 * F7, Studio's settings: its state and the aggregation warning, the namespaces it discovers, single
 * sign-on (turned on for a Studio installed with its own sign-in; once on, its client secret rotated
 * or single sign-on turned off again after the OIDC client's name is typed by hand, both by a Rancher
 * administrator), and uninstall after the release name is typed by hand. Each change is shown step
 * by step, and the page reloads after it.
 */
export default defineComponent({
  name: 'LibreDBSettings',

  components: {
    Banner, Checkbox, LabeledInput, LabeledSelect, Loading, SetupChecks, StepList, StudioStatus
  },

  data() {
    return {
      settings:         undefined as StudioSettings | undefined,
      namespaces:       [] as string[],
      confirm:          '',
      confirmingSso:    false,
      ownersTrusted:    false,
      confirmingRotate: false,
      ssoOffConfirm:    '',
      busy:             false,
      kind:             undefined as ChangeKind | undefined,
      steps:            [] as StepView[],
      undone:           [] as UndoEvent[],
      result:           undefined as ChangeResult | undefined,
      namespace:        STUDIO_NAMESPACE,
      recordName:       RECORD_CONFIGMAP,
    };
  },

  computed: {
    cluster(): string {
      return this.$route.params.cluster as string;
    },

    /** The record, only when it may steer an action */
    record(): SetupRecord | undefined {
      return this.settings?.recordProblem ? undefined : this.settings?.record;
    },

    namespacesError(): string | undefined {
      return namespacesError(this.namespaces, this.settings?.namespaces || []);
    },

    namespacesChanged(): boolean {
      return this.namespaces.slice().sort().join(',') !== (this.record?.namespaces || []).join(',');
    },

    redirectUri(): string | undefined {
      return this.settings?.host ? `https://${ this.settings.host }/api/auth/oidc/callback` : undefined;
    },

    uninstallConfirmed(): boolean {
      return !!this.record && this.confirm.trim() === this.record.release.name;
    },

    ssoOffConfirmed(): boolean {
      return !!this.record?.sso && this.ssoOffConfirm.trim() === this.record.sso.client;
    },

    setupRoute(): Record<string, unknown> {
      return { name: SETUP_ROUTE, params: { cluster: this.cluster, product: PRODUCT_NAME } };
    },
  },

  // No async/await, object spread or array spread in a .vue file: vue-jest compiles them to ES5
  // helpers that coverage counts as lines.
  created(): Promise<void> {
    return this.load();
  },

  methods: {
    load(): Promise<void> {
      return loadSettings(this.$store as StoreLike, this.cluster).then((settings) => {
        this.settings = settings;
        this.namespaces = settings.record ? settings.record.namespaces.slice() : [];
        this.confirmingSso = false;
        this.ownersTrusted = false;
        this.confirmingRotate = false;
      });
    },

    start(kind: ChangeKind, steps: ChangeStepId[]): ChangeOptions {
      this.busy = true;
      this.kind = kind;
      this.result = undefined;
      this.undone = [];
      this.steps = steps.map((step) => ({ step, state: 'pending' }));

      return {
        onStep: (event) => {
          this.steps = this.steps.map((item) => (item.step === event.step ? event : item));
        },
        onUndo: (event) => {
          this.undone.push(event);
        },
      };
    },

    finish(result: ChangeResult): Promise<void> {
      this.result = result;
      this.busy = false;
      this.confirm = '';
      this.ssoOffConfirm = '';

      return this.load();
    },

    // A rejection, such as a chunk that failed to load, is shown as a failed change
    broke(err: unknown): Promise<void> {
      return this.finish({
        ok: false, failure: failureOf(err), undone: this.undone
      });
    },

    save(): Promise<void> {
      const options = this.start('namespaces', ['upgrade', 'saveRecord']);

      return saveNamespaces(this.$store as StoreLike, this.cluster, this.record as SetupRecord, this.settings?.app as AppInfo, this.namespaces, options)
        .then(this.finish, this.broke);
    },

    askSso(): void {
      this.confirmingSso = true;
    },

    cancelSso(): void {
      this.confirmingSso = false;
      this.ownersTrusted = false;
    },

    turnOnSso(): Promise<void> {
      const settings = this.settings as StudioSettings;
      const sso = settings.sso as NonNullable<StudioSettings['sso']>;
      const steps: ChangeStepId[] = ['oidcClient', 'oidcSecret'];
      const options = this.start('sso', steps.concat(sso.context.cacerts ? ['rancherCA'] : [], ['upgrade', 'saveRecord']));

      // Exactly what the confirmation showed: the redirect's host, the namespaces to discover, and the acknowledgement
      const confirmed = {
        host: settings.host as string, namespaces: (this.record as SetupRecord).namespaces.slice(), ownersTrusted: this.ownersTrusted
      };

      return enableSso(this.$store as StoreLike, this.cluster, this.record as SetupRecord, settings.app as AppInfo, sso.context, confirmed, options)
        .then(this.finish, this.broke);
    },

    askRotate(): void {
      this.confirmingRotate = true;
    },

    cancelRotate(): void {
      this.confirmingRotate = false;
    },

    rotate(): Promise<void> {
      const options = this.start('rotate', ['regenerate', 'oidcSecret', 'restart']);

      return rotateClientSecret(this.$store as StoreLike, this.cluster, this.record as SetupRecord, this.settings?.app as AppInfo, options)
        .then(this.finish, this.broke);
    },

    turnOffSso(): Promise<void> {
      const record = this.record as SetupRecord;
      const options = this.start('ssoOff', ['upgrade', 'removeOidcClient', 'removeOidcSecret', 'removeRancherCA', 'saveRecord']);

      // Exactly what the page showed: the name typed by hand and the namespaces to discover
      const confirmed = { name: this.ssoOffConfirm, namespaces: record.namespaces.slice() };

      return disableSso(this.$store as StoreLike, this.cluster, record, this.settings?.app as AppInfo, confirmed, options).then(this.finish, this.broke);
    },

    uninstall(): Promise<void> {
      const options = this.start('uninstall', []);

      return uninstallStudio(this.$store as StoreLike, this.cluster, this.record as SetupRecord, this.confirm, options).then(this.finish, this.broke);
    },
  },
});
</script>

<template>
  <div class="libredb-settings">
    <header>
      <div class="title">
        <h1>{{ t('libredbStudio.settings.title', {}, true) }}</h1>
      </div>
    </header>
    <Loading v-if="!settings" />
    <Banner
      v-else-if="!settings.canChange"
      color="warning"
      data-testid="libredb-settings-not-owner"
      :label="t('libredbStudio.settings.notOwner')"
    />
    <template v-else>
      <StudioStatus
        v-if="settings.status && settings.link"
        :status="settings.status"
        :link="settings.link"
      />
      <Banner
        v-if="settings.aggregation && settings.aggregation.state !== 'ok'"
        color="warning"
        data-testid="libredb-settings-aggregation"
        :label="t(`libredbStudio.setup.checks.aggregation.${ settings.aggregation.reason }`)"
      />
      <Banner
        v-if="settings.inProject"
        color="error"
        data-testid="libredb-settings-in-project"
        :label="t('libredbStudio.settings.inProject', { namespace })"
      />
      <template v-if="kind">
        <StepList
          :steps="steps"
          :undone="undone"
          :undone-title-key="kind === 'uninstall' ? 'libredbStudio.settings.uninstalledTitle' : 'libredbStudio.setup.undoneTitle'"
        />
        <Banner
          v-if="result"
          :color="result.ok ? 'success' : 'error'"
          data-testid="libredb-settings-result"
          :label="t(`libredbStudio.settings.${ result.ok ? 'done' : 'failed' }.${ kind }`)"
        />
        <p
          v-if="result && result.failure && !result.failedStep"
          class="text-error"
          data-testid="libredb-settings-failure"
        >
          {{ t(`libredbStudio.setup.failure.${ result.failure.reason }`, result.failure.args, true) }}
        </p>
      </template>
      <Banner
        v-if="settings.recordProblem"
        color="error"
        data-testid="libredb-settings-untrusted"
        :label="t('libredbStudio.setup.failure.untrustedRecord', { field: settings.recordProblem })"
      />
      <Banner
        v-else-if="settings.recordUnreadable"
        color="warning"
        data-testid="libredb-settings-unreadable"
        :label="t('libredbStudio.settings.recordUnreadable', { namespace, name: recordName })"
      />
      <Banner
        v-else-if="!record && (settings.app || settings.link)"
        color="info"
        data-testid="libredb-settings-other"
        :label="t('libredbStudio.settings.otherInstall')"
      />
      <div
        v-else-if="!record"
        data-testid="libredb-settings-not-set-up"
      >
        <Banner
          color="info"
          :label="t('libredbStudio.settings.notSetUp')"
        />
        <router-link
          class="btn role-primary"
          :to="setupRoute"
          data-testid="libredb-settings-set-up"
        >
          {{ t('libredbStudio.setup.title', {}, true) }}
        </router-link>
      </div>
      <template v-else>
        <Banner
          v-if="settings.app && !settings.app.managed"
          color="warning"
          data-testid="libredb-settings-unmarked"
          :label="t('libredbStudio.settings.unmarked')"
        />
        <dl
          class="summary"
          data-testid="libredb-settings-summary"
        >
          <dt>{{ t('libredbStudio.settings.host', {}, true) }}</dt>
          <dd>{{ settings.host || t('libredbStudio.settings.unknownHost', {}, true) }}</dd>
          <dt>{{ t('libredbStudio.settings.chart', {}, true) }}</dt>
          <dd>{{ settings.app ? t('libredbStudio.settings.chartValue', { chartVersion: settings.app.chartVersion, appVersion: settings.app.appVersion }, true) : t('libredbStudio.settings.noApp', {}, true) }}</dd>
          <dt>{{ t('libredbStudio.settings.signIn', {}, true) }}</dt>
          <dd>{{ record.sso ? t('libredbStudio.settings.ssoOn', { client: record.sso.client }, true) : t('libredbStudio.settings.ssoOff', {}, true) }}</dd>
        </dl>
        <section
          v-if="settings.app"
          class="mb-20"
          data-testid="libredb-settings-namespaces"
        >
          <h3>{{ t('libredbStudio.setup.form.namespaces', {}, true) }}</h3>
          <LabeledSelect
            :value="namespaces"
            class="mb-10"
            :multiple="true"
            :label="t('libredbStudio.setup.form.namespaces')"
            :tooltip="t('libredbStudio.setup.form.namespacesHelp')"
            :options="settings.namespaces"
            data-testid="libredb-settings-namespaces-select"
            @update:value="namespaces = $event"
          />
          <p
            v-if="namespacesError"
            class="text-error"
            data-testid="libredb-settings-namespaces-error"
          >
            {{ t(`libredbStudio.setup.form.errors.${ namespacesError }`, {}, true) }}
          </p>
          <button
            type="button"
            class="btn role-primary"
            :disabled="busy || !namespacesChanged || !!namespacesError"
            data-testid="libredb-settings-save"
            @click="save"
          >
            {{ t('libredbStudio.settings.save', {}, true) }}
          </button>
        </section>
        <section
          v-if="settings.app && settings.sso"
          class="mb-20"
          data-testid="libredb-settings-sso"
        >
          <h3>{{ t('libredbStudio.settings.ssoTitle', {}, true) }}</h3>
          <p>{{ t('libredbStudio.settings.ssoIntro', {}, true) }}</p>
          <SetupChecks :checks="settings.sso.checks" />
          <template v-if="settings.sso.canUseSso">
            <button
              v-if="!confirmingSso"
              type="button"
              class="btn role-primary"
              :disabled="busy || !redirectUri"
              data-testid="libredb-settings-sso-start"
              @click="askSso"
            >
              {{ t('libredbStudio.settings.enableSso', {}, true) }}
            </button>
            <div
              v-else
              data-testid="libredb-settings-sso-confirm"
            >
              <p>{{ t('libredbStudio.settings.redirectConfirm', { uri: redirectUri }, true) }}</p>
              <p>{{ t('libredbStudio.settings.ssoNamespaces', { namespaces: record.namespaces.join(', ') }, true) }}</p>
              <Checkbox
                v-model:value="ownersTrusted"
                class="mb-10"
                :label="t('libredbStudio.setup.form.ssoTrust', {}, true)"
                data-testid="libredb-settings-sso-trust"
              />
              <button
                type="button"
                class="btn role-primary mr-10"
                :disabled="busy || !ownersTrusted"
                data-testid="libredb-settings-sso-confirm-button"
                @click="turnOnSso"
              >
                {{ t('libredbStudio.settings.confirm', {}, true) }}
              </button>
              <button
                type="button"
                class="btn role-secondary"
                :disabled="busy"
                data-testid="libredb-settings-sso-cancel"
                @click="cancelSso"
              >
                {{ t('libredbStudio.settings.cancel', {}, true) }}
              </button>
            </div>
          </template>
        </section>
        <section
          v-if="settings.app && record.sso"
          class="mb-20"
          data-testid="libredb-settings-sso-on"
        >
          <h3>{{ t('libredbStudio.settings.ssoTitle', {}, true) }}</h3>
          <p>{{ t('libredbStudio.settings.ssoOnIntro', { client: record.sso.client }, true) }}</p>
          <Banner
            v-if="!settings.ssoAdmin"
            color="info"
            data-testid="libredb-settings-sso-admin-only"
            :label="t('libredbStudio.settings.ssoAdminOnly')"
          />
          <template v-else>
            <div
              class="mb-20"
              data-testid="libredb-settings-rotate"
            >
              <h4>{{ t('libredbStudio.settings.rotateTitle', {}, true) }}</h4>
              <p>{{ t('libredbStudio.settings.rotateIntro', {}, true) }}</p>
              <button
                v-if="!confirmingRotate"
                type="button"
                class="btn role-primary"
                :disabled="busy"
                data-testid="libredb-settings-rotate-start"
                @click="askRotate"
              >
                {{ t('libredbStudio.settings.rotate', {}, true) }}
              </button>
              <div
                v-else
                data-testid="libredb-settings-rotate-confirm"
              >
                <p>{{ t('libredbStudio.settings.rotateConfirm', { client: record.sso.client }, true) }}</p>
                <button
                  type="button"
                  class="btn role-primary mr-10"
                  :disabled="busy"
                  data-testid="libredb-settings-rotate-confirm-button"
                  @click="rotate"
                >
                  {{ t('libredbStudio.settings.confirm', {}, true) }}
                </button>
                <button
                  type="button"
                  class="btn role-secondary"
                  :disabled="busy"
                  data-testid="libredb-settings-rotate-cancel"
                  @click="cancelRotate"
                >
                  {{ t('libredbStudio.settings.cancel', {}, true) }}
                </button>
              </div>
            </div>
            <div data-testid="libredb-settings-sso-off">
              <h4>{{ t('libredbStudio.settings.turnOffTitle', {}, true) }}</h4>
              <Banner
                color="warning"
                :label="t('libredbStudio.settings.turnOffWarning', { client: record.sso.client, namespace })"
              />
              <p>{{ t('libredbStudio.settings.ssoNamespaces', { namespaces: record.namespaces.join(', ') }, true) }}</p>
              <LabeledInput
                v-model:value="ssoOffConfirm"
                class="mb-10"
                :label="t('libredbStudio.settings.typeName', { name: record.sso.client })"
                data-testid="libredb-settings-sso-off-name"
              />
              <button
                type="button"
                class="btn bg-error"
                :disabled="busy || !ssoOffConfirmed"
                data-testid="libredb-settings-sso-off-button"
                @click="turnOffSso"
              >
                {{ t('libredbStudio.settings.turnOff', {}, true) }}
              </button>
            </div>
          </template>
        </section>
        <section data-testid="libredb-settings-uninstall">
          <h3>{{ t('libredbStudio.settings.uninstallTitle', {}, true) }}</h3>
          <Banner
            color="warning"
            :label="t('libredbStudio.settings.uninstallWarning', { namespace })"
          />
          <LabeledInput
            v-model:value="confirm"
            class="mb-10"
            :label="t('libredbStudio.settings.typeName', { name: record.release.name })"
            data-testid="libredb-settings-uninstall-name"
          />
          <button
            type="button"
            class="btn bg-error"
            :disabled="busy || !uninstallConfirmed"
            data-testid="libredb-settings-uninstall-button"
            @click="uninstall"
          >
            {{ t('libredbStudio.settings.uninstall', {}, true) }}
          </button>
        </section>
      </template>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.libredb-settings {
  .summary {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px 20px;
    margin: 20px 0;

    dt {
      color: var(--input-label);
    }
  }

  section {
    max-width: 640px;
  }
}
</style>
