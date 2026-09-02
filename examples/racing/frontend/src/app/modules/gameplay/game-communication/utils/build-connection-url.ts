import { environment } from '../../../../../environments/environment';

export function buildConnectionUrl(url: string): string {
  if (url.startsWith('::')) {
    const port: number = +url.substr(2);
    let rootUrl: string = environment.apiRoot;
    // check whether we already have port in our backend url
    if (rootUrl.match(/:\d+\/?$/)) {
      rootUrl = rootUrl.substr(0, rootUrl.lastIndexOf(':'));
    }
    url = `${rootUrl}:${port}`;
  }
  return url;
}
