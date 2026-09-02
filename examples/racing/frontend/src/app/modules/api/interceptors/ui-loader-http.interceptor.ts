import {Injectable} from '@angular/core';
import { HttpEvent, HttpHandler, HttpInterceptor, HttpRequest } from '@angular/common/http';

import {tap} from 'rxjs/operators';
import {Observable} from 'rxjs';
import { ApiService } from '../services/api.service';

@Injectable()
export class UiLoaderHttpInterceptor implements HttpInterceptor {

  constructor(
    private readonly api: ApiService,
  ) {
  }

  intercept(
    request: HttpRequest<any>,
    next: HttpHandler
  ): Observable<HttpEvent<any>> {
    if (request.url.endsWith('/ping')) {
      return next.handle(request);
    }

    this.api.isLoadingSomething$.next(true);
    return next.handle(request)
               .pipe(
                 tap(() => {
                   this.api.isLoadingSomething$.next(false);
                 })
               );
  }
}
