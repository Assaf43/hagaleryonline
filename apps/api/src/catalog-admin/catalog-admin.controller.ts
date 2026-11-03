import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type {
  AdminProduct,
  AdminProductPage,
  AdminSynonym,
  CatalogStructure,
  ImportReport,
  ProductStatusFilter,
} from '@hg/models';
import type { RequestMeta } from '../auth/auth.service.js';
import { id } from '../auth/body.js';
import {
  Admin,
  AdminAuthGuard,
  ClientMeta,
  RequirePermission,
  SameOriginGuard,
  SuperAdminOnly,
  type AdminContext,
} from '../auth/guards.js';
import {
  parseAttributeInput,
  parseAttributeValueInput,
  parseCategoryInput,
  parseProductInput,
  parseRoomInput,
  parseSynonymTerms,
} from './catalog-input.js';
import { ExcelService, XLSX } from './excel/excel.service.js';
import { ProductsAdminService } from './products-admin.service.js';
import { StructureAdminService } from './structure-admin.service.js';

const STATUSES: readonly ProductStatusFilter[] = ['all', 'active', 'hidden'];
const meta = (admin: AdminContext, client: RequestMeta) => ({ actorId: admin.user.id, ip: client.ip });

/** Products, prices and stock (ADM-02, ADM-12). Viewing needs catalog.view, saving catalog.edit. */
@Controller('admin/catalog/products')
@UseGuards(SameOriginGuard, AdminAuthGuard)
export class ProductsAdminController {
  constructor(private readonly products: ProductsAdminService) {}

  @Get()
  @RequirePermission('catalog.view')
  list(
    @Query('q') q?: string,
    @Query('categoryId') categoryId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
  ): Promise<AdminProductPage> {
    return this.products.list({
      q: q?.trim().slice(0, 100) || undefined,
      categoryId: categoryId ? id(categoryId) : undefined,
      status: STATUSES.includes(status as ProductStatusFilter) ? (status as ProductStatusFilter) : 'all',
      page: Math.max(1, Number.parseInt(page ?? '1', 10) || 1),
    });
  }

  @Get(':id')
  @RequirePermission('catalog.view')
  get(@Param('id') productId: string): Promise<AdminProduct> {
    return this.products.get(id(productId));
  }

  @Post()
  @RequirePermission('catalog.edit')
  create(@Body() body: unknown, @Admin() admin: AdminContext, @ClientMeta() client: RequestMeta) {
    return this.products.create(parseProductInput(body), meta(admin, client));
  }

  @Put(':id')
  @RequirePermission('catalog.edit')
  update(
    @Param('id') productId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ) {
    return this.products.update(id(productId), parseProductInput(body), meta(admin, client));
  }

  /** Permanent removal is the Super Admin's alone; everyone else hides products. */
  @Delete(':id')
  @SuperAdminOnly()
  @HttpCode(204)
  async remove(@Param('id') productId: string, @Admin() admin: AdminContext, @ClientMeta() client: RequestMeta) {
    await this.products.remove(id(productId), meta(admin, client));
  }
}

/** Categories, rooms, value lists and synonyms (ADM-03, ADM-17). Viewing needs catalog.view, changes catalog.structure. */
@Controller('admin/catalog')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('catalog.structure')
export class StructureAdminController {
  constructor(private readonly structure: StructureAdminService) {}

  @Get('structure')
  @RequirePermission('catalog.view')
  get(): Promise<CatalogStructure> {
    return this.structure.structure();
  }

  @Post('categories')
  @HttpCode(204)
  async createCategory(@Body() body: unknown, @Admin() admin: AdminContext, @ClientMeta() client: RequestMeta) {
    await this.structure.saveCategory(null, parseCategoryInput(body), meta(admin, client));
  }

  @Patch('categories/:id')
  @HttpCode(204)
  async updateCategory(
    @Param('id') categoryId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ) {
    await this.structure.saveCategory(id(categoryId), parseCategoryInput(body), meta(admin, client));
  }

  @Post('rooms')
  @HttpCode(204)
  async createRoom(@Body() body: unknown, @Admin() admin: AdminContext, @ClientMeta() client: RequestMeta) {
    await this.structure.saveRoom(null, parseRoomInput(body), meta(admin, client));
  }

  @Patch('rooms/:id')
  @HttpCode(204)
  async updateRoom(
    @Param('id') roomId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ) {
    await this.structure.saveRoom(id(roomId), parseRoomInput(body), meta(admin, client));
  }

  @Post('attributes')
  @HttpCode(204)
  async createAttribute(@Body() body: unknown, @Admin() admin: AdminContext, @ClientMeta() client: RequestMeta) {
    await this.structure.saveAttribute(null, parseAttributeInput(body), meta(admin, client));
  }

  @Patch('attributes/:id')
  @HttpCode(204)
  async updateAttribute(
    @Param('id') attributeId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ) {
    await this.structure.saveAttribute(id(attributeId), parseAttributeInput(body), meta(admin, client));
  }

  @Post('attributes/:id/values')
  @HttpCode(204)
  async createValue(
    @Param('id') attributeId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ) {
    await this.structure.saveValue(id(attributeId), null, parseAttributeValueInput(body), meta(admin, client));
  }

  @Patch('attributes/:id/values/:valueId')
  @HttpCode(204)
  async updateValue(
    @Param('id') attributeId: string,
    @Param('valueId') valueId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ) {
    await this.structure.saveValue(id(attributeId), id(valueId), parseAttributeValueInput(body), meta(admin, client));
  }

  @Delete('attributes/:id/values/:valueId')
  @HttpCode(204)
  async deleteValue(
    @Param('id') attributeId: string,
    @Param('valueId') valueId: string,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ) {
    await this.structure.deleteValue(id(attributeId), id(valueId), meta(admin, client));
  }

  @Post('synonyms')
  createSynonym(
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminSynonym> {
    return this.structure.saveSynonym(null, parseSynonymTerms(body), meta(admin, client));
  }

  @Patch('synonyms/:id')
  updateSynonym(
    @Param('id') synonymId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminSynonym> {
    return this.structure.saveSynonym(id(synonymId), parseSynonymTerms(body), meta(admin, client));
  }

  @Delete('synonyms/:id')
  @HttpCode(204)
  async deleteSynonym(@Param('id') synonymId: string, @Admin() admin: AdminContext, @ClientMeta() client: RequestMeta) {
    await this.structure.deleteSynonym(id(synonymId), meta(admin, client));
  }
}

/** The part of multer's file object we use. */
type UploadedExcel = { buffer: Buffer };

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const upload = FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
const download = (data: Buffer, name: string) =>
  new StreamableFile(data, { type: XLSX, disposition: `attachment; filename="${name}"`, length: data.length });

/** Excel template, export and import (ADM-09). Uploads are checked first and saved only on /import. */
@Controller('admin/catalog/excel')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('catalog.import')
export class ExcelController {
  constructor(private readonly excel: ExcelService) {}

  @Get('template')
  async template(): Promise<StreamableFile> {
    return download(await this.excel.template(), 'hagalery-template.xlsx');
  }

  @Get('export')
  async export(): Promise<StreamableFile> {
    return download(await this.excel.export(), `hagalery-catalog-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  @Post('check')
  @HttpCode(200)
  @UseInterceptors(upload)
  check(
    @UploadedFile() file: UploadedExcel | undefined,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<ImportReport> {
    return this.excel.run(file?.buffer ?? Buffer.alloc(0), meta(admin, client), false);
  }

  @Post('import')
  @HttpCode(200)
  @UseInterceptors(upload)
  import(
    @UploadedFile() file: UploadedExcel | undefined,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<ImportReport> {
    return this.excel.run(file?.buffer ?? Buffer.alloc(0), meta(admin, client), true);
  }
}
