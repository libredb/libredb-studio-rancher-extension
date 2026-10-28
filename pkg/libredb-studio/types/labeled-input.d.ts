import type { DefineComponent } from 'vue';

/**
 * The shell's LabeledInput.vue does not pass vue-tsc: its multiline branch binds a string or number
 * value to a string prop, and every .vue file an import reaches is checked with the package. So the
 * package type-checks against this declaration of the props it uses (tsconfig paths), while webpack
 * and Jest load the shell's component itself.
 */
export declare const LabeledInput: DefineComponent<{
  value?: string | number;
  label?: string;
  subLabel?: string;
  tooltip?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
}>;
