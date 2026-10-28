/** Never expose a proxy's HTML or a JSON parser exception as user guidance. */
export async function readApiJson(response: Response): Promise<any> {
  let data: any;
  try { data = await response.json(); }
  catch {
    const error = new Error('Together could not read the server response. Your messages and work have not been cleared. Try again when the connection returns.') as Error & {status: number};
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const fallback = response.status === 401 ? 'Your live access has expired. Reconnect to continue; your draft is still here.'
      : response.status >= 500 ? 'Together is temporarily unavailable. Your draft is still here; please try again shortly.'
      : 'This request could not be completed. Your draft is still here.';
    const error = new Error(response.status >= 500 || response.status === 401 ? fallback : data.error?.message ?? fallback) as Error & {status: number};
    error.status = response.status;
    throw error;
  }
  return data;
}
