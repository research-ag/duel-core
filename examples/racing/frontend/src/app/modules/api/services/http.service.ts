import { Observable, throwError as observableThrowError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Router } from '@angular/router';
import { environment } from '../../../../environments/environment';

@Injectable()
export class HttpService {

  private readonly apiUrl;
  private readonly apiHeaders;

  constructor(
    private readonly http: HttpClient,
    private readonly router: Router,
  ) {
    this.apiUrl = environment.apiRoot;
    this.apiHeaders = new HttpHeaders(
      {
        'Content-type': 'application/json'
      }
    );
  }

  apiGet<T>(path: string,
            params: string | URLSearchParams | {
              [key: string]: any | any[];
            } | null = null): Observable<T> {
    return this.apiCall<T>(RequestMethods.Get, path, params);
  }

  apiPost<T>(path: string, params?: any): Observable<T> {
    return this.apiCall<T>(RequestMethods.Post, path, params);
  }

  private apiCall<T>(method: RequestMethods, path: string, params: any = null): Observable<T> {
    let fullUrl: string = this.apiUrl;
    if (path && path.length > 0) {
      fullUrl += '/' + path;
    }
    switch (method) {
      case RequestMethods.Get:
      case RequestMethods.Post:
        return this.http.request<T>(method, fullUrl, {
          body: params && JSON.stringify(params),
          headers: this.apiHeaders || new HttpHeaders(),
          responseType: 'json',
          withCredentials: true,
          reportProgress: true,
          observe: 'body'
        })
          .pipe(catchError((res) => {
            console.log(res);
            switch (res.status) {
              case HttpStatus.Unauthorized:
                this.router.navigate(['login']);
                break;
              default:
                console.error(`No specific handler for error with status = ${res.status}`);
            }
            return observableThrowError(res.error);
          }),);
      default: {
        return observableThrowError(`Method ${method} is not supported! See http service`);
      }
    }
  }
}

enum RequestMethods {
  Get = 'get',
  Head = 'head',
  Post = 'post',
  Put = 'put',
  Patch = 'patch',
  Delete = 'delete',
  Connect = 'connect',
  Options = 'options',
  Trace = 'trace'
}

enum HttpStatus {
  BadRequest = 400,
  Unauthorized = 401
}
