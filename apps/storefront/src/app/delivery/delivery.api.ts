import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { DeliveryAnswerRequest, DeliveryLinkView } from '@hg/models';

/** The delivery confirmation link's calls (spec §5.3). Only called in the browser: the token is in the URL. */
@Injectable({ providedIn: 'root' })
export class DeliveryApi {
  private readonly http = inject(HttpClient);

  view(token: string) {
    return firstValueFrom(this.http.get<DeliveryLinkView>(`/api/delivery/${encodeURIComponent(token)}`));
  }

  answer(token: string, body: DeliveryAnswerRequest) {
    return firstValueFrom(this.http.post<DeliveryLinkView>(`/api/delivery/${encodeURIComponent(token)}`, body));
  }
}
