import {Injectable} from '@angular/core';
import { HttpEvent, HttpHandler, HttpInterceptor, HttpRequest } from '@angular/common/http';
import {catchError} from 'rxjs/operators';
import {Observable, throwError} from 'rxjs';
import {ConnectionMonitorService} from '../services/connection-monitor.service';

@Injectable()
export class ApiInterceptor implements HttpInterceptor {

  constructor(
    private readonly connectionMonitorService: ConnectionMonitorService,
  ) {
  }

  intercept(
    request: HttpRequest<any>,
    next: HttpHandler
  ): Observable<HttpEvent<any>> {
    if (request.url.endsWith('/ping')) {
      return next.handle(request);
    }
    return next.handle(request)
               .pipe(
                 catchError((err) => {
                   if (err.error instanceof ProgressEvent) {
                     this.connectionMonitorService.recheckConnection(true);
                   }
                   return throwError(() => err);
                 })
               );
  }
}
