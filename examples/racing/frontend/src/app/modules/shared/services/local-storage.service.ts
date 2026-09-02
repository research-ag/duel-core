import { BehaviorSubject, Observable, scheduled } from 'rxjs';
import { OptionDescriptor } from '../models/ls-option-descriptors';
import { distinctUntilChanged, startWith, takeUntil } from 'rxjs/operators';
import BaseService from './base.service';
import { Injectable } from '@angular/core';
import { AsapScheduler } from 'rxjs/internal/scheduler/AsapScheduler';
import { AsapAction } from 'rxjs/internal/scheduler/AsapAction';

@Injectable()
export class LocalStorageService extends BaseService {

  private storage: Storage;
  private subjects: Map<string, BehaviorSubject<any>>;

  constructor() {
    super();
    this.storage = window.localStorage;
    this.subjects = new Map<string, BehaviorSubject<any>>();
  }

  watch<T>(descriptor: OptionDescriptor<T>): Observable<T> {
    return this.watchKey(descriptor.key, descriptor.defaultValue);
  }

  watchKey(key: string, defaultValue: any = null): Observable<any> {
    if (!this.subjects.has(key)) {
      this.subjects.set(key, new BehaviorSubject<any>(defaultValue));
    }
    const subj = this.subjects.get(key) as BehaviorSubject<any>;
    const value = (this.storage.getItem(key) && JSON.parse(<string>this.storage.getItem(key)) || defaultValue);
    subj.next(value);
    return subj
      .asObservable()
      .pipe(takeUntil(this.destroyed));
  }

  get(key: string): any {
    return JSON.parse(this.storage.getItem(key) || 'null');
  }

  set(key: string, value: any) {
    this.storage.setItem(key, JSON.stringify(value));
    if (!this.subjects.has(key)) {
      this.subjects.set(key, new BehaviorSubject<any>(value));
    } else {
      (this.subjects.get(key) as BehaviorSubject<any>).next(value);
    }
  }

  remove(key: string) {
    if (this.subjects.has(key)) {
      (this.subjects.get(key) as BehaviorSubject<any>).complete();
      this.subjects.delete(key);
    }
    this.storage.removeItem(key);
  }

  clear() {
    this.subjects.clear();
    this.storage.clear();
  }

}
