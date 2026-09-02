import { NgModule } from '@angular/core';
import { UiLoaderHttpInterceptor } from './interceptors/ui-loader-http.interceptor';
import { ConnectionMonitorService } from './services/connection-monitor.service';
import { ApiInterceptor } from './interceptors/api.interceptor';
import { ApiService } from './services/api.service';
import { HttpService } from './services/http.service';
import { HTTP_INTERCEPTORS, provideHttpClient, withInterceptorsFromDi, withXhr } from '@angular/common/http';
import { LobbyService } from './services/lobby.service';

const services = [
  ConnectionMonitorService, ApiService, HttpService, LobbyService,
];

@NgModule({
  declarations: [],
  providers: [
    ...services,
    provideHttpClient(withXhr(), withInterceptorsFromDi()),
    {
      provide: HTTP_INTERCEPTORS,
      useClass: UiLoaderHttpInterceptor,
      multi: true,
    },
    {
      provide: HTTP_INTERCEPTORS,
      useClass: ApiInterceptor,
      multi: true,
    },
  ],
})
export class ApiModule {
}
