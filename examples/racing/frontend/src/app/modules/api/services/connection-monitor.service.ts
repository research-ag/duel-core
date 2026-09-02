import { BehaviorSubject, fromEvent, merge, of, Subject, timer } from 'rxjs';
import { catchError, map, mapTo, mergeMapTo, switchMap, takeUntil } from 'rxjs/operators';
import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../../environments/environment';

@Injectable()
export class ConnectionMonitorService implements OnDestroy {

  protected destroyed: Subject<void> = new Subject();

  private hasInternetConnection: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(navigator.onLine);
  public connected$: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(true);
  private recheckConnectionSubject: Subject<void> = new Subject<void>();

  constructor(
    private readonly http: HttpClient,
  ) {
    fromEvent(window, 'online')
      .pipe(takeUntil(this.destroyed))
      .subscribe(() => {
        this.hasInternetConnection.next(true);
      });
    fromEvent(window, 'offline')
      .pipe(takeUntil(this.destroyed))
      .subscribe(() => {
        this.hasInternetConnection.next(false);
      });
    merge(
      this.hasInternetConnection,
      this.recheckConnectionSubject,
    )
      .pipe(
        mapTo(this.hasInternetConnection.value),
        switchMap((connected: boolean) => {
          if (!connected) {
            return of(connected);
          } else {
            return timer(0, 30000)
              .pipe(
                takeUntil(this.destroyed),
                mergeMapTo(this.http.get(`${environment.apiRoot}/ping`, { responseType: 'text' })
                  .pipe(
                    map((res) => {
                      return true;
                    }),
                    catchError(() => {
                      return of(false);
                    })
                  )
                ),
              );
          }
        })
      )
      .subscribe(this.connected$);
  }

  public recheckConnection(ifState: boolean = true): void {
    if (ifState == this.connected$.value) {
      this.recheckConnectionSubject.next();
    }
  }

  public ngOnDestroy() {
    this.destroyed.next();
    this.destroyed.unsubscribe();
  }


}
