import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AiService } from './ai.service';
import {
  AiRecommendDto,
  AiQuoteEstimateDto,
  AiFaqDto,
  AiCategorizeDto,
} from './dto/ai-recommend.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { ThrottleStrict } from '../../common/decorators/throttle.decorator';

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.CUSTOMER)
@ThrottleStrict()
@Controller('ai')
export class AiController {
  constructor(private ai: AiService) {}

  @Post('recommend')
  @ApiOperation({
    summary:
      'AI: recommend services and providers based on a natural language query (Arabic/English)',
  })
  recommend(@Body() dto: AiRecommendDto) {
    return this.ai.recommendServices(dto);
  }

  @Post('quote-estimate')
  @ApiOperation({
    summary: 'AI: estimate a fair price range for a service request based on historical data',
  })
  quoteEstimate(@Body() dto: AiQuoteEstimateDto) {
    return this.ai.estimateQuote(dto);
  }

  @Post('faq')
  @ApiOperation({
    summary: 'AI: answer customer support questions in Arabic',
  })
  faq(@Body() dto: AiFaqDto) {
    return this.ai.answerFaq(dto);
  }

  @Post('categorize')
  @ApiOperation({
    summary: 'AI: auto-detect service category from a free-text description',
  })
  categorize(@Body() dto: AiCategorizeDto) {
    return this.ai.categorizeRequest(dto);
  }
}
