/** The part of the dashboard's Vuex store the services use */
export interface StoreLike {
  getters: Record<string, (type: string) => unknown>;
  dispatch(action: string, payload?: unknown): Promise<unknown>;
}
