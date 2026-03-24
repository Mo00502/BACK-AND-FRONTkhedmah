import {
  Controller,
  Post,
  Delete,
  Param,
  UseInterceptors,
  UploadedFile,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { FilesService } from './files.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ThrottleStrict } from '../../common/decorators/throttle.decorator';
import { memoryStorage } from 'multer';

@ApiTags('files')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('files')
export class FilesController {
  constructor(private files: FilesService) {}

  @Post('upload')
  @ThrottleStrict()
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  @ApiOperation({ summary: 'Upload a file (image or PDF) to S3' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
  })
  upload(@CurrentUser('id') userId: string, @UploadedFile() file: Express.Multer.File) {
    return this.files.upload(userId, file);
  }

  @Delete(':id')
  @ThrottleStrict()
  @ApiOperation({ summary: 'Delete an uploaded file (owner only)' })
  deleteFile(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.files.deleteFile(id, userId);
  }
}
