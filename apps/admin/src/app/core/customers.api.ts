import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  CodeTemplateOption,
  CustomerPage,
  CustomerProfile,
  IssuePersonalCodeRequest,
  IssuedPersonalCode,
  PersonalCodeSend,
} from '@hg/models';

const BASE = '/api/admin/customers';

/** "לקוחות" (spec §4.5, CLB-09): the list and profile (`customers.view`) and issuing a personal code (`club.manage`). */
@Injectable({ providedIn: 'root' })
export class CustomersApi {
  private readonly http = inject(HttpClient);

  list(q: string, page: number) {
    let params = new HttpParams().set('page', page);
    if (q) params = params.set('q', q);
    return firstValueFrom(this.http.get<CustomerPage>(BASE, { params }));
  }

  get(id: string) {
    return firstValueFrom(this.http.get<CustomerProfile>(`${BASE}/${encodeURIComponent(id)}`));
  }

  codeTemplates() {
    return firstValueFrom(this.http.get<CodeTemplateOption[]>(`${BASE}/code-templates`));
  }

  issueCode(customerId: string, templateId: number, send: PersonalCodeSend) {
    const body: IssuePersonalCodeRequest = { templateId, send };
    return firstValueFrom(this.http.post<IssuedPersonalCode>(`${BASE}/${encodeURIComponent(customerId)}/codes`, body));
  }
}
