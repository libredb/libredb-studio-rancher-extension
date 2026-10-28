<script lang="ts">
import { defineComponent } from 'vue';
import { Banner } from '@components/Banner';
import { Checkbox } from '@components/Form/Checkbox';
import { LabeledInput } from '@components/Form/LabeledInput';
import { RadioGroup } from '@components/Form/Radio';
import LabeledSelect from '@shell/components/form/LabeledSelect.vue';
import Loading from '@shell/components/Loading.vue';
import SetupChecks from '../components/SetupChecks.vue';
import StepList from '../components/StepList.vue';
import { PRODUCT_NAME, SETTINGS_ROUTE } from '../config';
import { failureOf } from '../services/setup/failure';
import {
  initialForm, isHostName, normalizeHost, planFrom, validateForm
} from '../services/setup/form';
import { installStudio, plannedSteps } from '../services/setup/install';
import { STUDIO_NAMESPACE } from '../services/setup/names';
import { runPreflight } from '../services/setup/preflight';
import type { FormErrors, SetupForm } from '../services/setup/form';
import type { InstallResult, StepView, UndoEvent } from '../services/setup/install';
import type { PreflightResult } from '../services/setup/preflight';
import type { StoreLike } from '../services/types';

/**
 * F6, the setup wizard: the preflight, the cluster owner's choices, then the install in Rancher
 * mode step by step, and on a failure what became of everything it had created.
 */
export default defineComponent({
  name: 'LibreDBSetup',

  components: {
    Banner, Checkbox, LabeledInput, LabeledSelect, Loading, RadioGroup, SetupChecks, StepList
  },

  data() {
    return {
      preflight:  undefined as PreflightResult | undefined,
      form:       undefined as SetupForm | undefined,
      phase:      'form' as 'form' | 'running' | 'done' | 'failed',
      showErrors: false,
      steps:      [] as StepView[],
      undone:     [] as UndoEvent[],
      result:     undefined as InstallResult | undefined,
      withSso:    false,
      namespace:  STUDIO_NAMESPACE,
    };
  },

  computed: {
    cluster(): string {
      return this.$route.params.cluster as string;
    },

    errors(): FormErrors {
      return this.preflight && this.form ? validateForm(this.form, this.preflight) : {};
    },

    errorReasons(): string[] {
      return Object.values(this.errors) as string[];
    },

    tlsOptions(): string[] {
      return this.preflight?.clusterIssuers.length ? ['secret', 'cert-manager'] : ['secret'];
    },

    /** The address Rancher sends people back to, shown before the install registers it */
    redirectUri(): string | undefined {
      const host = normalizeHost(this.form?.host || '');

      return isHostName(host) ? `https://${ host }/api/auth/oidc/callback` : undefined;
    },

    /** Studio is already here, which Settings changes or removes */
    alreadySetUp(): boolean {
      return !!this.preflight?.checks.some((check) => check.id === 'installed' && check.state === 'error');
    },

    settingsRoute(): Record<string, unknown> {
      return { name: SETTINGS_ROUTE, params: { cluster: this.cluster, product: PRODUCT_NAME } };
    },

    tlsLabels(): string[] {
      return this.tlsOptions.map((option) => this.t(`libredbStudio.setup.form.tls.${ option }`, { namespace: this.namespace }));
    },
  },

  // No async/await in a .vue file: vue-jest compiles it to ES5 helpers that coverage counts as lines.
  created(): Promise<void> {
    return this.check();
  },

  methods: {
    check(): Promise<void> {
      this.preflight = undefined;
      this.phase = 'form';
      this.showErrors = false;
      this.steps = [];
      this.undone = [];
      this.result = undefined;

      return runPreflight(this.$store as StoreLike, this.cluster).then((preflight) => {
        this.preflight = preflight;
        this.form = initialForm(preflight);
      });
    },

    install(): Promise<void> | undefined {
      if (this.errorReasons.length) {
        this.showErrors = true;

        return undefined;
      }

      const plan = planFrom(this.cluster, this.preflight as PreflightResult, this.form as SetupForm);

      this.withSso = !!plan.record.sso;
      this.steps = plannedSteps(plan).map((step) => ({ step, state: 'pending' }));
      this.undone = [];
      this.phase = 'running';

      return installStudio(this.$store as StoreLike, plan, {
        onStep: (event) => {
          this.steps = this.steps.map((item) => (item.step === event.step ? event : item));
        },
        onUndo: (event) => {
          this.undone.push(event);
        },
      }).then((result) => {
        this.result = result;
        this.phase = result.ok ? 'done' : 'failed';
      }, (err) => {
        this.result = {
          ok: false, failure: failureOf(err), undone: this.undone
        };
        this.phase = 'failed';
      });
    },
  },
});
</script>

<template>
  <div class="libredb-setup">
    <header>
      <div class="title">
        <h1>{{ t('libredbStudio.setup.title') }}</h1>
      </div>
    </header>
    <p class="mb-20">
      {{ t('libredbStudio.setup.intro') }}
    </p>
    <Loading v-if="!preflight" />
    <template v-else>
      <SetupChecks :checks="preflight.checks" />
      <div
        v-if="!preflight.canInstall"
        data-testid="libredb-setup-blocked"
      >
        <Banner
          color="warning"
          :label="t('libredbStudio.setup.blocked')"
        />
        <button
          type="button"
          class="btn role-secondary mr-10"
          data-testid="libredb-setup-check-again"
          @click="check"
        >
          {{ t('libredbStudio.setup.checkAgain') }}
        </button>
        <router-link
          v-if="alreadySetUp"
          class="btn role-primary"
          :to="settingsRoute"
          data-testid="libredb-setup-go-settings"
        >
          {{ t('libredbStudio.settings.label') }}
        </router-link>
      </div>
      <form
        v-else-if="phase === 'form' && form"
        class="setup-form"
        data-testid="libredb-setup-form"
        @submit.prevent="install"
      >
        <LabeledInput
          v-model:value="form.host"
          class="mb-10"
          :label="t('libredbStudio.setup.form.host')"
          :sub-label="t('libredbStudio.setup.form.hostHelp')"
          :required="true"
          data-testid="libredb-setup-host"
        />
        <LabeledSelect
          v-model:value="form.ingressClassName"
          class="mb-10"
          :label="t('libredbStudio.setup.form.ingressClass')"
          :options="preflight.ingressClasses"
          data-testid="libredb-setup-ingress-class"
        />
        <RadioGroup
          v-model:value="form.tlsSource"
          class="mb-10"
          name="libredb-setup-tls"
          :label="t('libredbStudio.setup.form.tlsTitle')"
          :options="tlsOptions"
          :labels="tlsLabels"
          data-testid="libredb-setup-tls"
        />
        <LabeledInput
          v-if="form.tlsSource === 'secret'"
          v-model:value="form.tlsSecretName"
          class="mb-10"
          :label="t('libredbStudio.setup.form.tlsSecretName')"
          data-testid="libredb-setup-tls-secret"
        />
        <LabeledSelect
          v-else
          v-model:value="form.clusterIssuer"
          class="mb-10"
          :label="t('libredbStudio.setup.form.clusterIssuer')"
          :options="preflight.clusterIssuers"
          data-testid="libredb-setup-cluster-issuer"
        />
        <LabeledSelect
          v-model:value="form.namespaces"
          class="mb-10"
          :multiple="true"
          :label="t('libredbStudio.setup.form.namespaces')"
          :tooltip="t('libredbStudio.setup.form.namespacesHelp')"
          :options="preflight.namespaces"
          data-testid="libredb-setup-namespaces"
        />
        <Checkbox
          v-model:value="form.sso"
          class="mb-10"
          :label="t('libredbStudio.setup.form.sso')"
          :disabled="!preflight.canUseSso"
          data-testid="libredb-setup-sso"
        />
        <p
          v-if="form.sso && redirectUri"
          data-testid="libredb-setup-redirect"
        >
          {{ t('libredbStudio.setup.form.redirect', { uri: redirectUri }) }}
        </p>
        <Banner
          v-if="!form.sso"
          color="info"
          data-testid="libredb-setup-local-sign-in"
          :label="t('libredbStudio.setup.form.localSignIn')"
        />
        <ul
          v-if="showErrors && errorReasons.length"
          class="text-error"
          data-testid="libredb-setup-errors"
        >
          <li
            v-for="reason in errorReasons"
            :key="reason"
          >
            {{ t(`libredbStudio.setup.form.errors.${ reason }`) }}
          </li>
        </ul>
        <button
          type="submit"
          class="btn role-primary"
          data-testid="libredb-setup-install"
        >
          {{ t('libredbStudio.setup.form.install') }}
        </button>
      </form>
      <template v-else>
        <StepList
          :steps="steps"
          :undone="undone"
        />
        <div
          v-if="phase === 'done' && result"
          data-testid="libredb-setup-done"
        >
          <Banner
            color="success"
            :label="t(withSso ? 'libredbStudio.setup.doneSso' : 'libredbStudio.setup.doneLocal', { namespace })"
          />
          <a
            v-if="result.link"
            class="btn role-primary mr-10"
            :href="result.link.toURL"
            target="_blank"
            rel="noopener noreferrer nofollow"
            data-testid="libredb-setup-open"
          >{{ t('libredbStudio.status.open') }}</a>
          <router-link
            class="btn role-secondary"
            :to="settingsRoute"
            data-testid="libredb-setup-settings"
          >
            {{ t('libredbStudio.settings.label') }}
          </router-link>
        </div>
        <div
          v-else-if="phase === 'failed' && result"
          data-testid="libredb-setup-failed"
        >
          <Banner
            color="error"
            :label="t('libredbStudio.setup.failed')"
          />
          <p
            v-if="!result.failedStep && result.failure"
            class="text-error"
            data-testid="libredb-setup-failure"
          >
            {{ t(`libredbStudio.setup.failure.${ result.failure.reason }`, result.failure.args) }}
          </p>
          <button
            type="button"
            class="btn role-secondary"
            data-testid="libredb-setup-retry"
            @click="check"
          >
            {{ t('libredbStudio.setup.checkAgain') }}
          </button>
        </div>
      </template>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.libredb-setup {
  .setup-form {
    max-width: 640px;
  }
}
</style>
