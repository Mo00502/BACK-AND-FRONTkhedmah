import { Module } from '@nestjs/common';
import { MapsService } from './maps.service';
import { MapsController } from './maps.controller';

@Module({
  controllers: [MapsController],
  providers: [MapsService],
  exports: [MapsService], // other modules (e.g. requests, search) can inject MapsService
})
export class MapsModule {}
