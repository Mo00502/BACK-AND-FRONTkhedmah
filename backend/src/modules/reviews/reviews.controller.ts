import { Controller, Post, Get, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ThrottleStrict, ThrottleRelaxed } from '../../common/decorators/throttle.decorator';

@ApiTags('reviews')
@UseGuards(JwtAuthGuard)
@Controller('reviews')
export class ReviewsController {
  constructor(private reviews: ReviewsService) {}

  @ThrottleStrict()
  @Post('requests/:requestId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit a review for a completed request' })
  create(
    @CurrentUser('id') raterId: string,
    @Param('requestId') requestId: string,
    @Body() dto: CreateReviewDto,
  ) {
    return this.reviews.create(raterId, requestId, dto);
  }

  @ThrottleRelaxed()
  @Public()
  @Get('providers/:providerId')
  @ApiOperation({ summary: 'Get all reviews for a provider' })
  getProviderReviews(
    @Param('providerId') providerId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.reviews.getProviderReviews(providerId, +page, +limit);
  }
}
