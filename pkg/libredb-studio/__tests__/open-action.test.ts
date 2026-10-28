import { flushPromises } from '@vue/test-utils';
import { CNPG_CLUSTER_TYPE } from '../config';
import { connectionId } from '../contract/connection-id';
import { clearReviews } from '../services/access';
import openInStudioAction from '../actions/open-in-studio';
import * as openService from '../services/open';
import type { ShellResource } from '../services/open';

const NAVLINK = { metadata: { name: 'studio.libredb-studio' }, spec: { toURL: 'https://studio.example.com' } };

const setup = (cluster: string, allowed: boolean | 'error' = true, navlinks: unknown[] = [NAVLINK]) => {
  const dispatch = jest.fn((action: string, _payload?: unknown) => {
    switch (action) {
    case 'cluster/findLabelSelector':
      return Promise.resolve(navlinks);
    case 'cluster/request':
      return allowed === 'error' ? Promise.reject(new Error('network')) : Promise.resolve({ status: { allowed } });
    default:
      return Promise.resolve();
    }
  });
  const resource: ShellResource = {
    type:         CNPG_CLUSTER_TYPE,
    metadata:     { namespace: 'team-a', name: 'orders' },
    $rootGetters: {
      'cluster/schemaFor': () => ({}),
      clusterId:           cluster,
      'i18n/t':            (key: string, args?: Record<string, unknown>) => `%${ key }%${ args ? JSON.stringify(args) : '' }`,
    },
    $dispatch: (action: string, payload?: unknown) => dispatch(action, payload),
  };

  clearReviews(cluster);

  return { dispatch, resource };
};

const enabled = (resource: ShellResource) => (openInStudioAction.enabled as (r: ShellResource) => unknown)(resource);
const invoke = (resource: ShellResource) => openInStudioAction.invoke({
  event: {}, isAlt: false, action: openInStudioAction
}, [resource]);

describe('open in LibreDB Studio row action', () => {
  it('is labelled through the translations, with an external-link icon, for one row at a time', () => {
    expect(openInStudioAction.labelKey).toBe('libredbStudio.databases.open');
    expect(openInStudioAction.icon).toBe('icon icon-external-link');
    expect(openInStudioAction.multiple).toBeFalsy();
  });

  it('is shown only once the NavLink is known and the review allows it, and enabled is never a Promise', async() => {
    const { resource } = setup('c-act-1');

    expect(enabled(resource)).toBe(false);
    await flushPromises();
    expect(enabled(resource)).toBe(false);
    await flushPromises();
    expect(enabled(resource)).toBe(true);
  });

  it('is not shown when the review refuses', async() => {
    const { resource } = setup('c-act-2', false);

    enabled(resource);
    await flushPromises();
    enabled(resource);
    await flushPromises();
    expect(enabled(resource)).toBe(false);
  });

  it('reviews again on invoke, then opens the Studio link without an opener', async() => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const { dispatch, resource } = setup('c-act-3');

    await expect(invoke(resource)).resolves.toBe(true);

    expect(dispatch).toHaveBeenCalledWith('cluster/request', expect.objectContaining({ method: 'post' }));
    expect(open).toHaveBeenCalledWith(`https://studio.example.com/?connection=seed%3A${ connectionId('cnpg', 'team-a', 'orders') }`, '_blank', 'noopener,noreferrer');
    expect(dispatch).not.toHaveBeenCalledWith('growl/warning', expect.anything());
  });

  it.each([
    ['denied', false, [NAVLINK]],
    ['failed', 'error', [NAVLINK]],
    ['not-set-up', true, []],
  ])('says why it did not open when the second check finds %s', async(reason, allowed, navlinks) => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const { dispatch, resource } = setup(`c-act-${ reason }`, allowed as boolean | 'error', navlinks);

    await expect(invoke(resource)).resolves.toBe(false);

    expect(open).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith('growl/warning', {
      title:   '%libredbStudio.open.refused%',
      message: `%libredbStudio.databases.reason.${ reason }%{"secret":"orders-app","namespace":"team-a"}`,
      timeout: 10000,
    });
  });

  it('does nothing for a kind the contract does not support', async() => {
    const { dispatch, resource } = setup('c-act-4');

    await expect(invoke({ ...resource, type: 'apps.deployment' })).resolves.toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('says it failed when the open itself fails', async() => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const { dispatch, resource } = setup('c-act-5');

    jest.spyOn(openService, 'openDatabase').mockRejectedValueOnce(new Error('Loading chunk studio-link failed'));

    await expect(invoke(resource)).resolves.toBe(false);

    expect(open).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith('growl/warning', {
      title:   '%libredbStudio.open.refused%',
      message: '%libredbStudio.databases.reason.failed%{"secret":"orders-app","namespace":"team-a"}',
      timeout: 10000,
    });
  });
});
