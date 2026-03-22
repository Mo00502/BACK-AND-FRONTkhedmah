import { Controller, Get, Post, Delete, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { FavouritesService } from './favourites.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ThrottleRelaxed, ThrottleDefault } from '../../common/decorators/throttle.decorator';

@ApiTags('favourites')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('favourites')
export class FavouritesController {
  constructor(private favs: FavouritesService) {}

  @ThrottleRelaxed()
  @Get()
  @ApiOperation({ summary: 'List my saved favourites (all or by type)' })
  @ApiQuery({ name: 'type', required: false, enum: ['PROVIDER', 'EQUIPMENT', 'TENDER'] })
  listMine(@CurrentUser('id') userId: string, @Query('type') type?: any) {
    return this.favs.listMine(userId, type);
  }

  @ThrottleDefault()
  @Post(':refType/:refId')
  @ApiOperation({ summary: 'Toggle favourite (save if not saved, remove if saved)' })
  toggle(
    @CurrentUser('id') userId: string,
    @Param('refType') refType: any,
    @Param('refId') refId: string,
  ) {
    return this.favs.toggle(userId, refType, refId);
  }

  @ThrottleRelaxed()
  @Get(':refType/:refId/status')
  @ApiOperation({ summary: 'Check if current user has saved this item' })
  isSaved(
    @CurrentUser('id') userId: string,
    @Param('refType') refType: any,
    @Param('refId') refId: string,
  ) {
    return this.favs.isSaved(userId, refType, refId);
  }

  @ThrottleRelaxed()
  @Public()
  @Get(':refType/:refId/count')
  @ApiOperation({ summary: 'How many users saved this item (public)' })
  count(@Param('refType') refType: any, @Param('refId') refId: string) {
    return this.favs.countForRef(refType, refId);
  }
}
