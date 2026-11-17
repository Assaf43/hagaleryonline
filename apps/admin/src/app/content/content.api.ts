import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  AdminAnnouncement,
  AdminAnnouncementInput,
  AdminFaqGroup,
  AdminFaqGroupInput,
  AdminInfoPage,
  AdminInfoPageInput,
  AdminSiteContent,
  AdminSiteContentInput,
} from '@hg/models';

const BASE = '/api/admin/content';

/** "תוכן" (Phase 8a, ADM-06, permission content.manage). Every update sends `expectedUpdatedAt` in the input. */
@Injectable({ providedIn: 'root' })
export class ContentApi {
  private readonly http = inject(HttpClient);

  site() {
    return firstValueFrom(this.http.get<AdminSiteContent>(`${BASE}/site`));
  }
  saveSite(input: AdminSiteContentInput) {
    return firstValueFrom(this.http.put<AdminSiteContent>(`${BASE}/site`, input));
  }

  announcements() {
    return firstValueFrom(this.http.get<AdminAnnouncement[]>(`${BASE}/announcements`));
  }
  announcement(id: number) {
    return firstValueFrom(this.http.get<AdminAnnouncement>(`${BASE}/announcements/${id}`));
  }
  createAnnouncement(input: AdminAnnouncementInput) {
    return firstValueFrom(this.http.post<AdminAnnouncement>(`${BASE}/announcements`, input));
  }
  updateAnnouncement(id: number, input: AdminAnnouncementInput) {
    return firstValueFrom(this.http.put<AdminAnnouncement>(`${BASE}/announcements/${id}`, input));
  }
  deleteAnnouncement(id: number) {
    return firstValueFrom(this.http.delete<void>(`${BASE}/announcements/${id}`));
  }

  pages() {
    return firstValueFrom(this.http.get<AdminInfoPage[]>(`${BASE}/pages`));
  }
  page(id: number) {
    return firstValueFrom(this.http.get<AdminInfoPage>(`${BASE}/pages/${id}`));
  }
  createPage(input: AdminInfoPageInput) {
    return firstValueFrom(this.http.post<AdminInfoPage>(`${BASE}/pages`, input));
  }
  updatePage(id: number, input: AdminInfoPageInput) {
    return firstValueFrom(this.http.put<AdminInfoPage>(`${BASE}/pages/${id}`, input));
  }
  deletePage(id: number) {
    return firstValueFrom(this.http.delete<void>(`${BASE}/pages/${id}`));
  }

  faqGroups() {
    return firstValueFrom(this.http.get<AdminFaqGroup[]>(`${BASE}/faq`));
  }
  faqGroup(id: number) {
    return firstValueFrom(this.http.get<AdminFaqGroup>(`${BASE}/faq/${id}`));
  }
  createFaqGroup(input: AdminFaqGroupInput) {
    return firstValueFrom(this.http.post<AdminFaqGroup>(`${BASE}/faq`, input));
  }
  updateFaqGroup(id: number, input: AdminFaqGroupInput) {
    return firstValueFrom(this.http.put<AdminFaqGroup>(`${BASE}/faq/${id}`, input));
  }
  deleteFaqGroup(id: number) {
    return firstValueFrom(this.http.delete<void>(`${BASE}/faq/${id}`));
  }
}
