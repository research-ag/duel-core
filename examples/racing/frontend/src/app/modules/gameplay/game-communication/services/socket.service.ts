import { Injectable } from '@angular/core';
import { Observable, Subject, throwError } from 'rxjs';
import { distinctUntilChanged, filter, takeUntil } from 'rxjs/operators';
import BaseService from '../../../shared/services/base.service';
import { ConnectionMonitorService } from '../../../api/services/connection-monitor.service';
import { io, Socket } from 'socket.io-client';

@Injectable()
export class SocketService extends BaseService {

  private socket: Socket | null = null;

  private subscriptionSubjects: Map<string, Subject<any>> = new Map<string, Subject<any>>();

  private connectedSubject: Subject<boolean> = new Subject<boolean>();

  constructor(
    private readonly connectionMonitorService: ConnectionMonitorService,
  ) {
    super();
    this.connectedSubject.pipe(
      takeUntil(this.destroyed),
      distinctUntilChanged(),
      filter(connected => !connected)
    )
      .subscribe(() => {
        this.connectionMonitorService.recheckConnection();
      });
  }

  public get $connected(): Observable<boolean> {
    return this.connectedSubject.asObservable();
  }

  public get isConnected(): boolean {
    return this.socket?.connected || false;
  }

  public init(url: string): void {
    if (this.socket) {
      this.disconnect();
    }
    this.socket = io(url, { autoConnect: false });
  }

  public connect(): Observable<boolean> {
    if (!this.socket) {
      throw new Error('?');
    }
    this.socket.once('connect', () => {
      this.connectedSubject.next(true);
    });
    this.socket.once('connect_error', (err: Error) => {
      this.connectedSubject.error(err);
    });
    this.socket.once('disconnect', (err: Socket.DisconnectReason) => {
      this.connectedSubject.next(false);
    });
    this.socket.connect();
    return this.$connected;
  }

  public disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    for (const subj of this.subscriptionSubjects.values()) {
      subj.complete();
    }
    this.subscriptionSubjects.clear();
  }

  public emit<T>(chanel: string, message?: any): Observable<T> {
    if (this.socket) {
      return this.emitInternal<T>(chanel, message);
    } else {
      throw throwError(() => new Error('Emitting message before socket creation'));
    }
  }

  on<T>(eventName: string): Observable<T> {
    if (!this.socket) {
      return throwError(() => new Error('Socket connection was not established!'));
    }
    let subject: Subject<T> | undefined = this.subscriptionSubjects.get(eventName);
    if (!subject) {
      subject = new Subject<T>();
      this.socket.on(eventName, (data: T) => {
        (subject as Subject<T>).next(data as T);
      });
      this.subscriptionSubjects.set(eventName, subject);
    }
    return subject.asObservable();
  }

  off(eventName: string): void {
    if (this.socket) {
      this.socket.off(eventName);
    }
    const sub = this.subscriptionSubjects.get(eventName);
    if (sub) {
      sub.complete();
      this.subscriptionSubjects.delete(eventName);
    }
  }

  ngOnDestroy(): void {
    super.ngOnDestroy();
    this.disconnect();
  }

  private emitInternal<T>(chanel: string, message?: any): Observable<T> {
    return new Observable<T>(observer => {
      if (!this.socket) {
        throw new Error('Socket is null');
      }
      this.socket.emit(chanel, message, (data: any): void => {
        if (data.success) {
          observer.next(data.msg as T);
        } else {
          observer.error(data.msg);
        }
        observer.complete();
      });
    });
  }

}
